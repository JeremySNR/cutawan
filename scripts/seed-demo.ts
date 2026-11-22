/**
 * Seeds a demo project into Cutawan's userData directory so the UI can be
 * inspected (and smoke-tested) without running the OpenAI pipeline.
 *
 * Run with: npx tsx --tsconfig tsconfig.node.json scripts/seed-demo.ts
 */
import { homedir } from 'node:os'
import { resolveUserDataPath } from '../src/main/userData'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { runFfmpeg, probeVideo, extractThumbnail } from '../src/main/pipeline/ffmpeg'
import { DEFAULT_CAPTION_STYLE_ID } from '../src/shared/captionStyles'
import type { Clip, Project, Transcript, TranscriptWord } from '../src/shared/types'
import { needsEditorialReview } from '../src/shared/editorialRanking'

const appData = process.platform === 'win32'
  ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
const USER_DATA = resolveUserDataPath(appData, process.env.CUTAWAN_USER_DATA)
const PROJECT_ID = 'demo-project-0000'

const SPEECH =
  'so here is the thing nobody tells you about growing an audience. the first hundred videos are practice. everyone I know who blew up posted consistently for a year before anything happened. and then one clip changes everything overnight. the algorithm is not against you it just has no idea who you are yet. give it evidence. post daily clips from your long content and let the data tell you what works.'

function makeTranscript(durationSec: number): Transcript {
  const words = SPEECH.split(' ')
  const perWord = (durationSec - 2) / words.length
  const all: TranscriptWord[] = words.map((w, i) => ({
    text: w,
    start: 1 + i * perWord,
    end: 1 + (i + 1) * perWord - 0.04
  }))
  const segSize = 12
  const segments = []
  for (let i = 0; i < all.length; i += segSize) {
    const slice = all.slice(i, i + segSize)
    segments.push({
      id: segments.length,
      text: slice.map((w) => w.text).join(' '),
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      words: slice,
      // Alternate delivery energy so auto-zoom punch-ins have targets.
      energy: segments.length % 2 === 1 ? 0.9 : 0.4
    })
  }
  return { language: 'english', durationSec, segments }
}

const DEMO_CLIPS: Array<Pick<Clip, 'title' | 'hook' | 'summary' | 'viralityScore' | 'viralityReason' | 'scoreBreakdown' | 'hashtags'> & { start: number; end: number }> = [
  {
    start: 14, end: 38,
    title: 'One clip changes everything overnight',
    hook: 'This is how creators actually blow up…',
    summary: 'The turning point every consistent creator eventually hits, and why it feels sudden.',
    viralityScore: 91,
    scoreBreakdown: { hook: 28, emotion: 23, value: 18, structure: 14, shareability: 8 },
    viralityReason: 'Strong curiosity hook, emotionally resonant payoff and a complete standalone arc.',
    hashtags: ['creator', 'growth', 'contentstrategy']
  },
  {
    start: 2, end: 20,
    title: 'The first 100 videos are practice',
    hook: 'Nobody tells you this about growing an audience',
    summary: 'A blunt reframe of early content as reps, not results.',
    viralityScore: 84,
    scoreBreakdown: { hook: 27, emotion: 20, value: 16, structure: 13, shareability: 8 },
    viralityReason: 'Contrarian opening line with high shareability among aspiring creators.',
    hashtags: ['contentcreator', 'mindset', 'audience']
  },
  {
    start: 38, end: 56,
    title: 'The algorithm is not against you',
    hook: 'Stop blaming the algorithm',
    summary: 'Why the algorithm ignores new creators and how to feed it evidence.',
    viralityScore: 76,
    scoreBreakdown: { hook: 24, emotion: 17, value: 17, structure: 12, shareability: 6 },
    viralityReason: 'Debunks a common excuse; strong discussion bait, slightly less emotional peak.',
    hashtags: ['algorithm', 'shorts', 'tiktokgrowth']
  },
  {
    start: 50, end: 68,
    title: 'Let the data tell you what works',
    hook: 'Post daily. Watch the data.',
    summary: 'The practical posting system: daily clips from long-form content.',
    viralityScore: 63,
    scoreBreakdown: { hook: 17, emotion: 13, value: 18, structure: 11, shareability: 4 },
    viralityReason: 'Actionable advice but a softer hook and less standalone tension.',
    hashtags: ['contentplan', 'repurposing', 'advice']
  }
]

async function main(): Promise<void> {
  const dir = join(USER_DATA, 'projects', PROJECT_ID)
  const thumbs = join(dir, 'thumbs')
  await mkdir(thumbs, { recursive: true })

  const videoPath = join(dir, 'demo-podcast.mp4')
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=70',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=70',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    videoPath
  ])
  const video = await probeVideo(videoPath)

  // A stand-in B-roll image so the editor's B-roll section has content.
  const brollImagePath = join(dir, 'demo-broll.png')
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'gradients=size=800x600:c0=purple:c1=orange:n=2',
    '-frames:v', '1',
    brollImagePath
  ])

  const clips: Clip[] = []
  for (let i = 0; i < DEMO_CLIPS.length; i++) {
    const d = DEMO_CLIPS[i]
    const id = `demo-clip-${i}`
    const thumbnailPath = await extractThumbnail(videoPath, d.start + 2, join(thumbs, `${id}.jpg`))
    clips.push({
      id,
      suggestedStart: d.start,
      suggestedEnd: d.end,
      title: d.title,
      hook: d.hook,
      summary: d.summary,
      viralityScore: d.viralityScore,
      viralityReason: d.viralityReason,
      scoreBreakdown: d.scoreBreakdown,
      visualSummary: null,
      hashtags: d.hashtags,
      thumbnailPath,
      broll:
        i === 0
          ? [
              {
                id: 'demo-broll-0',
                trigger: 'algorithm',
                query: 'computer algorithm visualisation',
                start: d.start + 5,
                end: d.start + 8,
                mode: 'overlay' as const,
                imagePath: brollImagePath,
                sourceUrl: 'https://example.com',
                enabled: true
              }
            ]
          : [],
      focusTrack:
        i === 0
          ? [
              { t: d.start, x: 0.3 },
              { t: d.start + 8, x: 0.68 },
              { t: d.start + 16, x: 0.32 }
            ]
          : null,
      edit: {
        aspect: '9:16',
        reframeMode: 'crop',
        framing: i === 0 ? 'auto' : 'manual',
        tightenCuts: false,
        autoZoom: true,
        focusX: 0.5,
        captionsEnabled: true,
        captionStyleId: DEFAULT_CAPTION_STYLE_ID,
        showTitle: i === 0,
        start: d.start,
        end: d.end
      }
    })
  }

  // A clip joined from two moments, so the grid label, the folded timeline
  // and the joined export path all have something to show.
  const first = { start: 2, end: 12 }
  const second = { start: 50, end: 62 }
  clips.push({
    id: 'demo-clip-joined',
    suggestedStart: first.start,
    suggestedEnd: second.end,
    title: 'Practice first, then let the data decide',
    hook: 'Your first videos are reps',
    summary: 'The reframe of early content as practice, joined to the posting system it leads to.',
    viralityScore: 58,
    viralityReason: 'A clear claim paired with its practical answer; lower emotional peak.',
    scoreBreakdown: { hook: 18, emotion: 10, value: 17, structure: 9, shareability: 4 },
    visualSummary: null,
    hashtags: ['contentplan', 'mindset'],
    thumbnailPath: await extractThumbnail(videoPath, first.start + 2, join(thumbs, 'demo-clip-joined.jpg')),
    broll: [],
    focusTrack: null,
    reframeStatus: 'done',
    reframeAnalysis: { start: first.start, end: second.end, version: 2, ranges: [first, second] },
    stitch: { segments: [first, second], reason: 'Demo fixture: skips the stretch about the algorithm between the claim and the system.' },
    edit: {
      aspect: '9:16',
      reframeMode: 'crop',
      framing: 'manual',
      tightenCuts: false,
      autoZoom: true,
      focusX: 0.5,
      captionsEnabled: true,
      captionStyleId: DEFAULT_CAPTION_STYLE_ID,
      showTitle: false,
      start: first.start,
      end: second.end,
      cuts: [{ start: first.end, end: second.start }]
    }
  })

  const project: Project = {
    id: PROJECT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    name: 'Demo: creator growth podcast',
    video,
    transcript: makeTranscript(video.durationSec),
    clips,
    prompt: '',
    videoType: 'podcast'
  }
  // Scripted UI states, explicitly labelled fixtures rather than model evidence.
  clips[0].editorial = { ...needsEditorialReview(clips[0], project.transcript!, 'Demo fixture: a complete thought with a clear landing.'),
    status: 'reviewed', story: 'complete', fidelity: 'supported', score: 75,
    scores: { hook: 3, clarity: 3, value: 3, payoff: 3, audienceFit: null }, concerns: [],
    takeaway: 'Demo fixture for checking the editorial assessment UI.' }
  clips[1].editorial = needsEditorialReview(clips[1], project.transcript!, 'Demo fixture: check the source for missing setup.')
  clips[2].editorial = { ...clips[0].editorial, selectionKey: 'outdated-fixture-selection' }
  await writeFile(join(dir, 'project.json'), JSON.stringify(project), 'utf8')
  console.log(`Seeded demo project at ${dir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
