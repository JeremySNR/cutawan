// Only this child process loads native ONNX code. Never import it in Electron's main process.
import * as ort from 'onnxruntime-node'
import { open } from 'node:fs/promises'
import type { InferenceRequest, InferenceResponse, TensorData } from './protocol'

const sessions = new Map<string, ort.InferenceSession>()
process.on('disconnect', () => process.exit(0))
process.on('message', (request: InferenceRequest) => {
  void run(request).then(response => {
    if (process.connected) process.send?.(response)
  })
})

async function run(request: InferenceRequest): Promise<InferenceResponse> {
  const inputs: Record<string, ort.Tensor> = {}
  let results: ort.InferenceSession.ReturnType | undefined
  try {
    let session = sessions.get(request.modelPath)
    if (!session) {
      session = await ort.InferenceSession.create(request.modelPath, {
        logSeverityLevel: 3,
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        executionMode: 'sequential',
        enableCpuMemArena: false,
        enableMemPattern: false
      })
      sessions.set(request.modelPath, session)
    }
    if (request.vad) return { id: request.id, outputs: await runVad(session, request), peakRssBytes: process.resourceUsage().maxRSS * 1024 }
    for (const [name, input] of Object.entries(request.inputs)) {
      inputs[name] = new ort.Tensor('float32', input.data, input.dims)
    }
    for (const [name, input] of Object.entries(request.int64Inputs ?? {})) {
      inputs[name] = new ort.Tensor('int64', input.data, input.dims)
    }
    results = await session.run(inputs)
    const outputs: Record<string, TensorData> = {}
    for (const [name, tensor] of Object.entries(results)) {
      if (tensor.type !== 'float32') throw new Error(`Unexpected inference output type: ${tensor.type}`)
      // Own the data before disposing the native tensors.
      outputs[name] = { data: new Float32Array(tensor.data as Float32Array), dims: tensor.dims }
    }
    return { id: request.id, outputs, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) }
  } finally {
    for (const tensor of Object.values(inputs)) tensor.dispose()
    for (const tensor of Object.values(results ?? {})) tensor.dispose()
  }
}

/** Silero VAD v5 at 16 kHz: 512-sample chunks, each preceded by 64 samples of context. */
const VAD_CHUNK = 512
const VAD_CONTEXT = 64

async function runVad(session: ort.InferenceSession, request: InferenceRequest): Promise<Record<string, TensorData>> {
  const { pcmPath, fromSample, sampleCount } = request.vad!
  const file = await open(pcmPath, 'r')
  const bytes = Buffer.alloc(sampleCount * 2)
  let read: number
  try {
    read = (await file.read(bytes, 0, bytes.length, fromSample * 2)).bytesRead
  } finally { await file.close() }
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(read / 2))
  let state = new Float32Array(request.inputs.state.data)
  const context = new Float32Array(request.inputs.context.data)
  const chunks = Math.floor(samples.length / VAD_CHUNK)
  const probs = new Float32Array(chunks)
  const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [])
  const frame = new Float32Array(VAD_CONTEXT + VAD_CHUNK)
  try {
    for (let c = 0; c < chunks; c++) {
      frame.set(context, 0)
      for (let i = 0; i < VAD_CHUNK; i++) frame[VAD_CONTEXT + i] = samples[c * VAD_CHUNK + i] / 32768
      const input = new ort.Tensor('float32', frame, [1, frame.length])
      const stateIn = new ort.Tensor('float32', state, [2, 1, 128])
      const out = await session.run({ input, state: stateIn, sr })
      probs[c] = (out.output.data as Float32Array)[0]
      state = new Float32Array(out.stateN.data as Float32Array)
      context.set(frame.subarray(frame.length - VAD_CONTEXT))
      input.dispose(); stateIn.dispose()
      for (const tensor of Object.values(out)) tensor.dispose()
    }
  } finally { sr.dispose() }
  return {
    probs: { data: probs, dims: [chunks] },
    state: { data: state, dims: [2, 1, 128] },
    context: { data: context, dims: [VAD_CONTEXT] }
  }
}
