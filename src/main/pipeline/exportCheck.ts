import { rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ExportCheckFinding, ExportCheckReport, TimeRange, Transcript, VideoInfo } from '@shared/types'
import { clipKeptSegments, isFiller } from '@shared/tighten'
import { clipTimeline, type TimelineClip } from '@shared/clipTimeline'
import { formatCheckTime } from '@shared/exportCheck'
import { FFMPEG_PATH, FFPROBE_PATH, probeVideo, runBinary, runBinaryFull } from './ffmpeg'
import { mediaThreads } from './mediaJobs'
import { loudnormFilter, measureLoudness, TARGET_I, TARGET_TP } from './loudness'
import { audioArgs, encoderArgs } from './encoders'
import type { RenderJob, RenderResult } from './render'

/**
 * The check after every export, with automatic repair where it is safe.
 *
 * One extra decode of the finished file, with the picture shrunk to a
 * thumbnail, looks for:
 *
 * - black picture (blackdetect), at the ends or anywhere the source has none;
 * - frozen picture (freezedetect) much longer than the source holds still at
 *   the same place: a slide or a still shot is not a fault, a stuck decoder
 *   or a repeated frame is;
 * - dead air at the very start or end (silencedetect);
 * - integrated loudness and true peak against the export target (ebur128);
 *
 * and, from the edit itself, cuts that land inside a word.
 *
 * Repairs: black or silent stretches at either end are trimmed (the video
 * stream copied when a keyframe allows, re-encoded otherwise for short
 * clips), and a level that missed the target gets one more linear
 * normalisation with the video copied. A repaired file is kept only if the
 * same check on it is strictly better and it is otherwise the same file;
 * otherwise the original stays.
 *
 * Never fatal and never slow: every failure is a "not checked" report, the
 * analysis and the repair each run under a time limit, and only the user
 * cancelling the export stops it. Measured on a 4-core VM against the test
 * renders (scripts/test-pipeline.ts, 15 s 1080x1920): the analysis pass
 * takes 0.6-0.9 s against 9-13 s of rendering and validating, about 7%.
 */

/** Width the picture is shrunk to for the black and freeze detectors. */
const ANALYSIS_WIDTH = 96
/** blackdetect: a frame is black when 98% of it is below 10% grey. */
const BLACK_FILTER = 'blackdetect=d=0.1:pix_th=0.10'
/** A frozen stretch shorter than this is not worth reporting. */
const FREEZE_MIN_SEC = 3
/** freezedetect noise floor; at thumbnail size, sensor noise on a still shot sits well above it. */
const FREEZE_NOISE = '-50dB'
/** Silence: below -50 dBFS for at least 0.1 s. */
const SILENCE_FILTER = 'silencedetect=n=-50dB:d=0.1'
/** How close to the start or end a run must be to count as "at" it. */
const EDGE_SEC = 0.05
/**
 * Black at the very end shorter than this is not reported: a stream-copied
 * tail cut can leave up to three black frames (see RepairPlan.tailSlack),
 * and the last tenth of a second of a clip is rarely seen.
 */
const END_BLACK_MIN_SEC = 0.2
/** Black inside the clip shorter than this is a flash, not a fault. */
const MID_BLACK_MIN_SEC = 0.5
/**
 * Dead air at the start is trimmed past this, down to HEAD_KEEP_SEC (the
 * same breath pause removal keeps before the first word); at the end past
 * TAIL_DEAD_SEC, down to TAIL_KEEP_SEC.
 */
const HEAD_DEAD_SEC = 1
const HEAD_KEEP_SEC = 0.3
const TAIL_DEAD_SEC = 1.5
const TAIL_KEEP_SEC = 0.7
/** Dead air that cannot be trimmed is reported past these lengths. */
const HEAD_REPORT_SEC = 2
const TAIL_REPORT_SEC = 3
/** Trims never take more than this share of the clip, or leave less than MIN_LEFT_SEC. */
const MAX_TRIM_SHARE = 0.4
const MIN_LEFT_SEC = 1
/** Loudness further than this from the target is repaired. */
const LOUDNESS_TOLERANCE_LU = 1
/** True peak above the ceiling by more than this is repaired (AAC overshoots a few tenths). */
const PEAK_TOLERANCE_DB = 0.5
/** Below this the clip is essentially silent: there is no level to correct. */
const QUIET_LUFS = -45
/** A head trim with no keyframe to cut at re-encodes the video only for clips up to this long. */
const REENCODE_MAX_SEC = 120
/** Source footage the freeze and black comparisons may decode. */
const MAX_VERIFY_SEC = 60
/** A word must be at least this long, and the cut this far inside it, to call the cut mid-word. */
const MID_WORD_MIN_SEC = 0.12
const MID_WORD_MARGIN_SEC = 0.05

export interface ExportAnalysis {
  black: TimeRange[]
  freeze: TimeRange[]
  silence: TimeRange[]
  integratedLufs: number | null
  truePeakDb: number | null
}

/** Pull the detector reports out of ffmpeg's log. Open runs end at `duration`. Pure. */
export function parseAnalysis(stderr: string, duration: number): ExportAnalysis {
  const number = (text: string | undefined): number | null => {
    const value = Number(text)
    return text !== undefined && Number.isFinite(value) ? value : null
  }
  const black = [...stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)]
    .map(m => ({ start: Number(m[1]), end: Number(m[2]) }))
  const pairs = (startPattern: RegExp, endPattern: RegExp): TimeRange[] => {
    const events = [
      ...[...stderr.matchAll(startPattern)].map(m => ({ at: m.index ?? 0, start: Number(m[1]) })),
      ...[...stderr.matchAll(endPattern)].map(m => ({ at: m.index ?? 0, end: Number(m[1]) }))
    ].sort((a, b) => a.at - b.at)
    const out: TimeRange[] = []
    let open: number | null = null
    for (const event of events) {
      if ('start' in event) open = event.start
      else if (open !== null) { out.push({ start: open, end: event.end }); open = null }
    }
    if (open !== null) out.push({ start: open, end: duration })
    return out.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
  }
  const freeze = pairs(/freeze_start:\s*([\d.]+)/g, /freeze_end:\s*([\d.]+)/g)
  const silence = pairs(/silence_start:\s*(-?[\d.]+)/g, /silence_end:\s*([\d.]+)/g)
    .map(r => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const integrated = summary.includes('Summary:') ? number(/I:\s*(-?[\d.]+)\s*LUFS/.exec(summary)?.[1]) : null
  const peak = summary.includes('Summary:') ? number(/Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(summary)?.[1]) : null
  return { black, freeze, silence, integratedLufs: integrated, truePeakDb: peak }
}

/**
 * One decode with every detector. `duration` closes runs still open at the
 * end; `range` limits the decode to part of the file (source comparisons).
 */
async function analyse(
  path: string, opts: { hasAudio: boolean; duration: number; video?: 'all' | 'black' | 'freeze'; freezeMinSec?: number; range?: TimeRange },
  signal: AbortSignal
): Promise<ExportAnalysis> {
  const threads = String(mediaThreads())
  const video = opts.video ?? 'all'
  const detectors = [
    video !== 'freeze' ? BLACK_FILTER : null,
    video !== 'black' ? `freezedetect=n=${FREEZE_NOISE}:d=${opts.freezeMinSec ?? FREEZE_MIN_SEC}` : null
  ].filter(Boolean).join(',')
  const graph = [`[0:v:0]scale=${ANALYSIS_WIDTH}:-2:flags=area,${detectors}[v]`]
  if (opts.hasAudio) graph.push(`[0:a:0]${SILENCE_FILTER},ebur128=peak=true:framelog=verbose[a]`)
  const range = opts.range ? ['-ss', opts.range.start.toFixed(3), '-t', (opts.range.end - opts.range.start).toFixed(3)] : []
  const { stderr } = await runBinaryFull(FFMPEG_PATH, [
    '-hide_banner', '-nostats', '-threads', threads, '-filter_threads', threads,
    // Faster decoding is fine for thumbnails: deblocking changes nothing a
    // 96-pixel detector can see.
    '-skip_loop_filter', 'all', '-flags2', 'fast',
    ...range, '-i', path,
    '-filter_complex', graph.join(';'), '-map', '[v]', ...(opts.hasAudio ? ['-map', '[a]'] : []), '-f', 'null', '-'
  ], { signal })
  return parseAnalysis(stderr, opts.range ? opts.range.end - opts.range.start : opts.duration)
}

/** What the judgement needs to know about the clip besides the analysis. */
export interface CheckContext {
  duration: number
  hasAudio: boolean
  /** Output ranges kept on purpose though silent or still (visual payoffs, active pauses). */
  protectedOutput: TimeRange[]
  /** Pause removal is on: dead air at the ends is something the user asked to lose. */
  tightenCuts: boolean
  wholeVideo: boolean
}

export interface RepairPlan {
  /** Seconds to trim from the start and from the end. */
  head: number
  tail: number
  /**
   * Silence just before the tail cut. A stream copy can only end the
   * picture a few frames late (B-frames are stored out of order), so the
   * cut may be pulled this much earlier to keep a black tail out entirely.
   */
  tailSlack: number
  loudness: boolean
}

/** Something to compare with the source before reporting. */
export interface Suspect { kind: 'black' | 'freeze'; start: number; end: number }

const covered = (range: TimeRange, runs: TimeRange[]): number =>
  runs.reduce((sum, r) => sum + Math.max(0, Math.min(r.end, range.end) - Math.max(r.start, range.start)), 0)
const overlaps = (range: TimeRange, list: TimeRange[]): boolean => list.some(r => r.start < range.end && r.end > range.start)
const sec = (value: number): string => `${value.toFixed(1)} s`

/**
 * Findings and a repair plan from one analysis. Pure. Black and freezes
 * inside the clip come back as suspects, to be compared with the source.
 */
export function judgeExport(a: ExportAnalysis, ctx: CheckContext): {
  findings: ExportCheckFinding[]; plan: RepairPlan; suspects: Suspect[]
  /** How far from right the ends and the level are, for comparing a repair with the original. */
  badness: number
} {
  const { duration } = ctx
  const findings: ExportCheckFinding[] = []
  const atStart = (r: TimeRange): boolean => r.start <= EDGE_SEC
  const atEnd = (r: TimeRange): boolean => r.end >= duration - EDGE_SEC
  const still = [...a.black, ...a.freeze]
  const stillOver = (range: TimeRange): boolean => range.end - range.start <= 0 ||
    covered(range, still) >= 0.9 * (range.end - range.start)
  const silentAll = { start: 0, end: duration }
  const deadAllowed = (range: TimeRange): boolean => !ctx.wholeVideo && !overlaps(range, ctx.protectedOutput) &&
    (ctx.tightenCuts || stillOver(range))

  // Start: black is trimmed only as far as the audio is silent too (black
  // over speech stays: losing words is worse), dead air down to a breath.
  const blackHead = a.black.find(atStart)
  const silentHead = ctx.hasAudio ? a.silence.find(atStart) : silentAll
  const headBlack = blackHead ? Math.min(blackHead.end, silentHead?.end ?? 0) : 0
  const headSilence = silentHead && ctx.hasAudio ? silentHead.end : 0
  const headDead = headSilence > HEAD_DEAD_SEC && deadAllowed({ start: 0, end: headSilence }) ? headSilence - HEAD_KEEP_SEC : 0
  let head = Math.max(headBlack >= 0.1 ? headBlack : 0, headDead)
  if (blackHead) findings.push({ kind: 'black', at: 0, duration: blackHead.end, message: `Starts with ${sec(blackHead.end)} of black picture.` })
  if (headDead > 0 || headSilence > HEAD_REPORT_SEC) {
    findings.push({ kind: 'silence-start', at: 0, duration: headSilence, message: `Starts with ${sec(headSilence)} of silence.` })
  }

  const blackTail = a.black.find(r => atEnd(r) && (atStart(r) || r.end - r.start >= END_BLACK_MIN_SEC))
  const silentTail = ctx.hasAudio ? a.silence.find(atEnd) : silentAll
  const tailBlack = blackTail ? duration - Math.max(blackTail.start, silentTail?.start ?? duration) : 0
  const tailSilence = silentTail && ctx.hasAudio ? duration - silentTail.start : 0
  const tailDead = tailSilence > TAIL_DEAD_SEC && deadAllowed({ start: duration - tailSilence, end: duration }) ? tailSilence - TAIL_KEEP_SEC : 0
  let tail = Math.max(tailBlack >= 0.1 ? tailBlack : 0, tailDead)
  if (blackTail && blackTail !== blackHead) {
    findings.push({ kind: 'black', at: blackTail.start, duration: duration - blackTail.start, message: `Ends with ${sec(duration - blackTail.start)} of black picture.` })
  }
  if (tailDead > 0 || tailSilence > TAIL_REPORT_SEC) {
    findings.push({ kind: 'silence-end', at: duration - tailSilence, duration: tailSilence, message: `Ends with ${sec(tailSilence)} of silence.` })
  }
  // A whole-video edit is the user's own programme: report its ends, never trim them.
  if (ctx.wholeVideo || head + tail > MAX_TRIM_SHARE * duration || duration - head - tail < MIN_LEFT_SEC) head = tail = 0
  const tailSlack = tail > 0 && silentTail ? Math.max(0, duration - tail - silentTail.start) : 0

  const suspects: Suspect[] = [
    ...a.black.filter(r => !atStart(r) && !atEnd(r) && r.end - r.start >= MID_BLACK_MIN_SEC).map(r => ({ kind: 'black' as const, ...r })),
    ...a.freeze.filter(r => r.end - r.start >= FREEZE_MIN_SEC).map(r => ({ kind: 'freeze' as const, ...r }))
  ]

  let loudness = false
  let badness = (blackHead?.end ?? 0) + (blackTail && blackTail !== blackHead ? duration - blackTail.start : 0) + headDead + tailDead
  if (ctx.hasAudio && a.integratedLufs !== null && a.integratedLufs > QUIET_LUFS) {
    badness += Math.max(0, Math.abs(a.integratedLufs - TARGET_I) - LOUDNESS_TOLERANCE_LU)
    badness += Math.max(0, (a.truePeakDb ?? -Infinity) - TARGET_TP - PEAK_TOLERANCE_DB)
    if (Math.abs(a.integratedLufs - TARGET_I) > LOUDNESS_TOLERANCE_LU) {
      loudness = true
      findings.push({ kind: 'loudness', message: `The audio is at ${a.integratedLufs.toFixed(1)} LUFS; the target is ${TARGET_I}.` })
    }
    if (a.truePeakDb !== null && a.truePeakDb > TARGET_TP + PEAK_TOLERANCE_DB) {
      loudness = true
      findings.push({ kind: 'true-peak', message: `The audio peaks at ${a.truePeakDb.toFixed(1)} dBTP, over the ${TARGET_TP} ceiling.` })
    }
  }
  return { findings, plan: { head, tail, tailSlack, loudness }, suspects, badness }
}

/**
 * Internal cuts that land inside a word: a word boundary from the
 * transcript strictly around the cut, unless voice activity says it is
 * silent there (word timings are approximate; voice activity is acoustic).
 * One finding for all of them, in exported-file time (after any cold
 * open). Pure.
 */
export function midWordCuts(
  clip: TimelineClip, transcript: Transcript | null
): ExportCheckFinding | null {
  if (!transcript) return null
  const kept = clipKeptSegments(clip, transcript)
  if (!kept || kept.length < 2) return null
  const timeline = clipTimeline(clip, transcript)
  const words = transcript.segments.flatMap(s => s.words)
    .filter(w => w.end - w.start >= MID_WORD_MIN_SEC && !isFiller(w.sourceText ?? w.text))
  const speech = transcript.speech
  const edges = kept.flatMap((piece, i) => [i > 0 ? piece.start : null, i < kept.length - 1 ? piece.end : null])
    .filter((t): t is number => t !== null)
  const hits: Array<{ at: number; word: string }> = []
  for (const edge of edges) {
    if (speech?.length && !speech.some(r => r.start < edge && edge < r.end)) continue
    const word = words.find(w => w.start + MID_WORD_MARGIN_SEC < edge && edge < w.end - MID_WORD_MARGIN_SEC)
    if (!word) continue
    const at = timeline.toOutput(edge)
    if (!hits.some(h => Math.abs(h.at - at) < 0.01)) hits.push({ at, word: (word.sourceText ?? word.text).trim() })
  }
  if (!hits.length) return null
  const message = hits.length === 1
    ? `The cut at ${formatCheckTime(hits[0].at)} lands inside the word “${hits[0].word}”.`
    : `${hits.length} cuts land inside words (at ${hits.map(h => formatCheckTime(h.at)).join(', ')}).`
  return { kind: 'mid-word', at: hits[0].at, message }
}

/** Source spans the exported range [start, end) was cut from. */
function sourceSpans(job: RenderJob, range: TimeRange): TimeRange[] {
  // The cold open, when there is one, plays its own source span first.
  return clipTimeline(job.clip, job.transcript).pieces.flatMap(piece => {
    const from = piece.outStart
    const to = from + piece.end - piece.start
    const start = Math.max(from, range.start), end = Math.min(to, range.end)
    return end > start ? [{ start: piece.start + start - from, end: piece.start + end - from }] : []
  })
}

/**
 * Keep the suspects the source does not explain: the export is black or
 * frozen for clearly longer than the same footage is in the source.
 */
async function confirmSuspects(job: RenderJob, suspects: Suspect[], signal: AbortSignal): Promise<ExportCheckFinding[]> {
  const out: ExportCheckFinding[] = []
  let budget = MAX_VERIFY_SEC
  for (const suspect of suspects) {
    const spans = sourceSpans(job, suspect)
    const span = spans.reduce((sum, r) => sum + r.end - r.start, 0)
    if (span > budget) continue
    budget -= span
    let still = 0
    for (const range of spans) {
      const result = await analyse(job.source.path, { hasAudio: false, duration: 0, video: suspect.kind, freezeMinSec: 0.5, range }, signal)
      still += covered({ start: 0, end: range.end - range.start }, suspect.kind === 'black' ? result.black : result.freeze)
    }
    const length = suspect.end - suspect.start
    if (length - still < Math.max(1, 0.5 * length)) continue
    out.push(suspect.kind === 'black'
      ? { kind: 'black', at: suspect.start, duration: length,
          message: `${sec(length)} of black picture at ${formatCheckTime(suspect.start)} that the source does not have.` }
      : { kind: 'freeze', at: suspect.start, duration: length,
          message: `The picture freezes for ${sec(length)} at ${formatCheckTime(suspect.start)}, longer than the source holds still there.` })
  }
  return out
}

/** Keyframe times in the first `until` seconds of the file's video. */
async function keyframes(path: string, until: number, signal: AbortSignal): Promise<number[]> {
  const out = await runBinary(FFPROBE_PATH, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-read_intervals', `%+${(until + 0.5).toFixed(3)}`, '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path], { signal })
  return out.split(/\s+/).map(Number).filter(Number.isFinite)
}

/** Write a repaired copy of `path`, or return null when the plan cannot be carried out safely. */
async function writeRepair(
  path: string, plan: RepairPlan, info: VideoInfo, job: RenderJob, result: RenderResult, signal: AbortSignal
): Promise<{ path: string; head: number; tail: number; loudness: boolean } | null> {
  let head = 0
  let reencode = false
  if (plan.head > 0) {
    // Copying the video needs a keyframe to start on. x264 puts one where
    // the picture changes sharply, so the end of a black opening usually has one.
    const frame = 1 / Math.max(1, info.fps)
    const key = (await keyframes(path, plan.head, signal))
      .filter(k => k >= Math.max(0.1, plan.head * 0.5) && k <= plan.head + frame / 2).pop()
    if (key !== undefined) head = key
    else if (!job.sizeTargetBytes && info.durationSec <= REENCODE_MAX_SEC) { head = plan.head; reencode = true }
  }
  // Pull a copied tail cut back by up to the B-frame delay (x264 keeps at
  // most 3 frames back), but only inside silence.
  const tail = plan.tail > 0 && !reencode ? plan.tail + Math.min(plan.tailSlack, 4 / Math.max(1, info.fps)) : plan.tail
  const end = info.durationSec - tail
  const stats = plan.loudness && info.hasAudio ? await measureLoudness(path, head, end - head, signal) : null
  const loudness = stats !== null
  if (head === 0 && tail === 0 && !loudness) return null

  const reencodeAudio = info.hasAudio && (head > 0 || loudness)
  const audioCodec = result.sizePlan
    ? (result.sizePlan.audioKbps > 0 ? ['-c:a', 'aac', '-b:a', `${result.sizePlan.audioKbps}k`] : [])
    : audioArgs(job.quality ?? 'standard')
  const filters = [
    loudness ? `${loudnormFilter(stats)},aresample=48000,aformat=channel_layouts=stereo` : null,
    // A trimmed end lost the render's fade; trims only ever end in silence,
    // but a short fade keeps the edge clean whatever the room tone does.
    tail > 0 && reencodeAudio ? `afade=t=out:st=${Math.max(0, end - head - 0.1).toFixed(3)}:d=0.1` : null
  ].filter(Boolean).join(',')
  const output = `${path}.repair-${randomUUID()}.mp4`
  const threads = String(mediaThreads())
  await runBinaryFull(FFMPEG_PATH, [
    '-hide_banner', '-y', '-v', 'error', '-threads', threads,
    // Just past the keyframe, so the seek cannot round to the one before it.
    ...(head > 0 ? ['-ss', (head + (reencode ? 0 : 0.0005)).toFixed(4)] : []),
    '-i', path, '-t', (end - head).toFixed(3),
    '-map', '0:v:0', '-map', '0:a?',
    ...(reencode ? encoderArgs('cpu', job.quality ?? 'standard') : ['-c:v', 'copy']),
    ...(info.hasAudio ? (reencodeAudio ? [...audioCodec, ...(filters ? ['-af', filters] : [])] : ['-c:a', 'copy']) : []),
    '-movflags', '+faststart', output
  ], { signal })
  return { path: output, head, tail, loudness }
}

function linkedSignal(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timed out')), ms)
  const forward = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) forward()
  parent?.addEventListener('abort', forward, { once: true })
  return { signal: controller.signal, done: () => { clearTimeout(timer); parent?.removeEventListener('abort', forward) } }
}

/**
 * Check the rendered file at `path` (before it is moved into place) and
 * repair it in place when that is safe. Resolves to the report; rejects only
 * when the export itself was cancelled.
 */
export async function checkExport(path: string, job: RenderJob, result: RenderResult): Promise<ExportCheckReport> {
  const started = performance.now()
  const seconds = (): number => Math.round((performance.now() - started) / 10) / 100
  let repairedPath: string | null = null
  try {
    const info = await probeVideo(path)
    const ctx: CheckContext = {
      duration: info.durationSec,
      hasAudio: info.hasAudio,
      protectedOutput: protectedOutputRanges(job),
      tightenCuts: Boolean(job.clip.edit.tightenCuts && job.transcript),
      wholeVideo: job.clip.origin === 'whole-video'
    }
    // The analysis may take up to half the clip's length (it normally takes
    // a few percent); past that the export goes out unchecked.
    const analysisTime = linkedSignal(job.signal, Math.max(15, info.durationSec * 0.5) * 1000)
    let analysis: ExportAnalysis
    let judged: ReturnType<typeof judgeExport>
    let confirmed: ExportCheckFinding[]
    try {
      analysis = await analyse(path, { hasAudio: info.hasAudio, duration: info.durationSec }, analysisTime.signal)
      judged = judgeExport(analysis, ctx)
      confirmed = await confirmSuspects(job, judged.suspects, analysisTime.signal)
    } finally {
      analysisTime.done()
    }
    const midWord = midWordCuts(job.clip, job.transcript)
    // What a repair can change (the ends, the level), and what it cannot
    // (inside the clip), which only moves with a trimmed start.
    let fixable = judged.findings
    let fixed: ExportCheckFinding[] = []
    let inside = [...confirmed, ...(midWord ? [midWord] : [])]
    let loudness = measuredLoudness(analysis)

    const { plan } = judged
    if (plan.head > 0 || plan.tail > 0 || plan.loudness) {
      const repairTime = linkedSignal(job.signal, Math.max(20, info.durationSec) * 1000)
      try {
        const repair = await writeRepair(path, plan, info, job, result, repairTime.signal)
        if (repair) {
          repairedPath = repair.path
          const after = await probeVideo(repair.path)
          const expected = info.durationSec - repair.head - repair.tail
          const sameFile = after.width === info.width && after.height === info.height && after.hasAudio === info.hasAudio &&
            Math.abs(after.durationSec - expected) <= 0.1 + 2 / Math.max(1, info.fps)
          const recheck = await analyse(repair.path, { hasAudio: after.hasAudio, duration: after.durationSec }, repairTime.signal)
          const rejudged = judgeExport(recheck, { ...ctx, duration: after.durationSec,
            protectedOutput: ctx.protectedOutput.map(r => ({ start: r.start - repair.head, end: r.end - repair.head })) })
          const afterFindings = rejudged.findings
          // Strictly better: nothing new wrong, and less wrong overall.
          const slotsBefore = new Set(fixable.map(slot))
          const better = afterFindings.every(f => slotsBefore.has(slot(f))) && afterFindings.length <= fixable.length &&
            rejudged.badness < judged.badness - 0.05
          if (sameFile && better) {
            await rename(repair.path, path)
            repairedPath = null
            const slotsAfter = new Set(afterFindings.map(slot))
            fixed = fixedFindings(fixable.filter(f => !slotsAfter.has(slot(f))), repair, analysis)
            fixable = afterFindings
            inside = inside.map(f => f.at === undefined ? f : { ...f, at: Math.max(0, f.at - repair.head) })
            loudness = measuredLoudness(recheck) ?? loudness
            console.info('[export-check] repaired', JSON.stringify({ head: repair.head, tail: repair.tail, loudness: repair.loudness }))
          } else {
            console.info('[export-check] repair not better; keeping the original',
              JSON.stringify({ sameFile, before: judged.badness, after: rejudged.badness }))
          }
        }
      } catch (error) {
        if (job.signal?.aborted) throw error
        console.warn('[export-check] repair failed; keeping the original:', error)
      } finally {
        repairTime.done()
      }
    }
    const findings = [...fixable, ...inside, ...fixed]
    const report: ExportCheckReport = { status: 'checked', findings, seconds: seconds(), ...(loudness ? { loudness } : {}) }
    console.info('[export-check]', JSON.stringify({ seconds: report.seconds, findings: findings.map(f => `${f.kind}${f.repaired ? '*' : ''}`) }))
    return report
  } catch (error) {
    if (job.signal?.aborted) throw error
    console.warn('[export-check] could not check the export:', error)
    return { status: 'skipped', findings: [], seconds: seconds(), note: 'The check after export could not run; the file was saved as rendered.' }
  } finally {
    if (repairedPath) await rm(repairedPath, { force: true }).catch(() => undefined)
  }
}

function measuredLoudness(a: ExportAnalysis): ExportCheckReport['loudness'] | undefined {
  return a.integratedLufs !== null && a.truePeakDb !== null && a.integratedLufs > -70
    ? { integratedLufs: a.integratedLufs, truePeakDb: a.truePeakDb } : undefined
}

/** Which problem a finding is, so a repaired file's findings can be matched to the original's. */
function slot(f: ExportCheckFinding): string {
  return f.kind === 'black' ? `black-${f.at === 0 ? 'start' : 'end'}` : f.kind
}

/**
 * The findings a repair cleared, reworded as what was done. Black and
 * silence trimmed from the same end are one fix, said once.
 */
function fixedFindings(cleared: ExportCheckFinding[], repair: { head: number; tail: number }, before: ExportAnalysis): ExportCheckFinding[] {
  const slots = new Set(cleared.map(slot))
  return cleared.flatMap((f): ExportCheckFinding[] => {
    const s = slot(f)
    if ((s === 'silence-start' && slots.has('black-start')) || (s === 'silence-end' && slots.has('black-end'))) return []
    const both = (s === 'black-start' && slots.has('silence-start')) || (s === 'black-end' && slots.has('silence-end'))
    const end = s === 'black-start' ? 'start' : 'end'
    const message = both
      ? `Trimmed ${sec(end === 'start' ? repair.head : repair.tail)} of black picture and silence from the ${end}.`
      : fixMessage(f, repair, before)
    return [{ kind: f.kind, message, ...(f.duration !== undefined ? { duration: f.duration } : {}), repaired: true }]
  })
}

/** What was done about a finding the repair cleared. */
function fixMessage(f: ExportCheckFinding, repair: { head: number; tail: number }, before: ExportAnalysis): string {
  switch (f.kind) {
    case 'black': return f.at === 0 ? `Trimmed ${sec(repair.head)} of black picture from the start.` : `Trimmed ${sec(repair.tail)} of black picture from the end.`
    case 'silence-start': return `Trimmed ${sec(repair.head)} of silence from the start.`
    case 'silence-end': return `Trimmed ${sec(repair.tail)} of silence from the end.`
    case 'loudness': return `Levelled the audio from ${before.integratedLufs?.toFixed(1)} to ${TARGET_I} LUFS.`
    case 'true-peak': return `Brought the audio peak from ${before.truePeakDb?.toFixed(1)} dBTP under ${TARGET_TP}.`
    default: return f.message
  }
}

/**
 * Protected source stretches (visual payoffs, active pauses), in exported-file
 * time: wherever they play, the cold open included. Pure.
 */
export function protectedOutputRanges(job: Pick<RenderJob, 'clip' | 'transcript'>): TimeRange[] {
  const ranges = [...(job.clip.visualStory?.protectedRanges ?? []), ...(job.clip.gapActivity?.active ?? [])]
  if (!ranges.length) return []
  const timeline = clipTimeline(job.clip, job.transcript)
  return ranges.flatMap(r => timeline.mapRange(r)).sort((a, b) => a.start - b.start)
}
