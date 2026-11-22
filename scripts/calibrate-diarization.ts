/**
 * Measure diarization on labelled recordings, to choose and check the
 * clustering thresholds in src/main/pipeline/speakerTurns.ts.
 *
 *   CUTAWAN_SPEAKER_MODEL=/path/to/campplus.onnx \
 *   npx tsx --tsconfig tsconfig.node.json scripts/calibrate-diarization.ts a.wav a.json [b.wav b.json …]
 *
 * Each JSON is { "turns": [{ "start", "end", "speaker" }] } ground truth.
 * TRUTH_SPEECH=1 uses those turns as voice activity instead of Silero.
 * Prints same- vs different-speaker cosine distances between windows, then
 * the speaker count and frame error for a range of thresholds.
 */
import { detectSpeech } from '../src/main/pipeline/vad'
import { analyseSourceAudio } from '../src/main/pipeline/audioAnalysis'
import { speakerModelPath } from '../src/main/pipeline/speakerModel'
import { FFPROBE_PATH, runBinary } from '../src/main/pipeline/ffmpeg'
import { DEFAULT_CLUSTER, alignTurnsToWords, clusterSpeakers, labelTimeline, l2normalize } from '../src/main/pipeline/speakerTurns'
import { stopInference } from '../src/main/inference/client'
import type { SpeakerTurn } from '../src/shared/types'
import { readFileSync } from 'node:fs'

interface Truth { turns: SpeakerTurn[] }

const speakerAt = (turns: SpeakerTurn[], t: number): number => turns.find(x => t >= x.start && t < x.end)?.speaker ?? -1

/** Share of truth speech time labelled with the wrong speaker under the best one-to-one mapping (greedy). */
function frameError(truth: SpeakerTurn[], hyp: SpeakerTurn[], end: number): { error: number; missed: number } {
  const counts = new Map<string, number>()
  let speech = 0, missed = 0
  for (let t = 0; t < end; t += 0.1) {
    const s = speakerAt(truth, t)
    if (s < 0) continue
    speech++
    const h = speakerAt(hyp, t)
    if (h < 0) { missed++; continue }
    counts.set(`${s}:${h}`, (counts.get(`${s}:${h}`) ?? 0) + 1)
  }
  const used = new Set<string>()
  let correct = 0
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const [s, h] = key.split(':')
    if (used.has(`s${s}`) || used.has(`h${h}`)) continue
    used.add(`s${s}`); used.add(`h${h}`); correct += n
  }
  return { error: 1 - (correct + missed) / Math.max(1, speech), missed: missed / Math.max(1, speech) }
}

async function main(): Promise<void> {
  const model = await speakerModelPath()
  if (!model) throw new Error('Set CUTAWAN_SPEAKER_MODEL to the CAM++ ONNX file.')
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) {
    const wav = args[i]
    const truth = (JSON.parse(readFileSync(args[i + 1], 'utf8')) as Truth).turns
    const info = { durationSec: Number(await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav])) }
    let started = performance.now()
    // TRUTH_SPEECH=1 uses the labelled turns as voice activity (for signals Silero does not take for speech).
    const speech = process.env.TRUTH_SPEECH ? truth.map(t => ({ start: t.start, end: t.end })) : await detectSpeech(wav)
    const vadSec = (performance.now() - started) / 1000
    started = performance.now()
    const raw = await analyseSourceAudio({ videoPath: wav, durationSec: info.durationSec, reactions: true, diarize: { speech, modelPath: model } }, () => {})
    const analysisSec = (performance.now() - started) / 1000
    const windows = raw.embedded!.windows
    const embeddings = raw.embedded!.embeddings.map(e => l2normalize(e!))
    const truthOf = windows.map(w => speakerAt(truth, (w.start + w.end) / 2))
    const same: number[] = [], diff: number[] = []
    for (let a = 0; a < windows.length; a++) {
      for (let b = a + 1; b < windows.length; b++) {
        if (truthOf[a] < 0 || truthOf[b] < 0) continue
        let dot = 0
        for (let k = 0; k < embeddings[a].length; k++) dot += embeddings[a][k] * embeddings[b][k]
        ;(truthOf[a] === truthOf[b] ? same : diff).push(1 - dot)
      }
    }
    const pct = (v: number[], p: number): string => v.length ? [...v].sort((x, y) => x - y)[Math.floor(p * (v.length - 1))].toFixed(3) : '-'
    console.log(`\n== ${wav}: ${info.durationSec.toFixed(0)} s, ${new Set(truth.map(t => t.speaker)).size} voices, ${windows.length} windows`)
    console.log(`   timing: VAD ${vadSec.toFixed(1)} s, decode+reactions+embeddings ${analysisSec.toFixed(1)} s`)
    console.log(`   same-speaker distance  p5 ${pct(same, 0.05)} p50 ${pct(same, 0.5)} p95 ${pct(same, 0.95)} p99 ${pct(same, 0.99)}`)
    console.log(`   cross-speaker distance p1 ${pct(diff, 0.01)} p5 ${pct(diff, 0.05)} p50 ${pct(diff, 0.5)} p95 ${pct(diff, 0.95)}`)
    for (const [threshold, mergeSimilarity] of [[0.5, 0.8], [0.6, 0.7], [0.6, 0.8], [0.6, 0.9], [0.7, 0.8]]) {
      const labels = clusterSpeakers(embeddings, { ...DEFAULT_CLUSTER, threshold, mergeSimilarity })
      const timeline = labelTimeline(windows, labels, speech)
      const turns = alignTurnsToWords(timeline, [])
      const found = turns.length ? new Set(turns.map(t => t.speaker)).size : 1
      const { error, missed } = frameError(truth, turns.length ? turns : timeline.map(t => ({ ...t, speaker: 0 })), info.durationSec)
      const isDefault = threshold === DEFAULT_CLUSTER.threshold && mergeSimilarity === DEFAULT_CLUSTER.mergeSimilarity
      console.log(`   cut ${threshold.toFixed(2)} merge ${mergeSimilarity.toFixed(2)}${isDefault ? '*' : ' '}: ${found} speakers, ${turns.length} turns, ` +
        `error ${(error * 100).toFixed(1)}% (missed ${(missed * 100).toFixed(1)}%)`)
    }
  }
  stopInference()
}

main().catch(error => { console.error(error); process.exit(1) })
