/**
 * Offline end-to-end check of the Metachlorian handoff (no OpenAI calls, no
 * Electron): imports tests/fixtures/metachlorian-package, an A-roll stringout
 * with one video B-roll insert, then renders the imported edit and checks
 * the result frame by frame:
 *
 * - the insert's footage covers the picture between its start and end, and
 *   it is the footage from mediaIn on (the insert file is blue for its first
 *   second and red after; mediaIn is 1 s, so only red may appear);
 * - the A-roll shows before and after it;
 * - the A-roll's audio carries on underneath the insert;
 * - pause removal with the insert in place still renders.
 *
 * Run with: npx tsx --tsconfig tsconfig.node.json scripts/test-handoff.ts
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { probeVideo, runBinaryFull, runFfmpeg, FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import { renderClip } from '../src/main/pipeline/render'
import { importHandoffPackage } from '../src/main/handoff'

const WORK = join(process.cwd(), '.tmp', 'handoff-test')
const FIXTURE = resolve(__dirname, '../tests/fixtures/metachlorian-package')

/** Average colour of the top half of the frame at `t` (captions sit lower down). */
async function topColour(video: string, t: number): Promise<[number, number, number]> {
  const out = join(WORK, `frame-${t.toFixed(2)}.rgb`)
  await runFfmpeg(['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1',
    '-vf', 'crop=iw:ih/2:0:0,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out])
  const [r, g, b] = await readFile(out)
  return [r, g, b]
}

const isRed = ([r, g, b]: [number, number, number]): boolean => r > 150 && g < 90 && b < 90

/** Mean volume in dB of [from, from + length). */
async function meanVolume(video: string, from: number, length: number): Promise<number> {
  const { stderr } = await runBinaryFull(FFMPEG_PATH, ['-v', 'info', '-ss', from.toFixed(3), '-t', length.toFixed(3),
    '-i', video, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)
  assert.ok(match, 'volumedetect reported no mean volume')
  return match[1] === '-inf' ? -Infinity : Number(match[1])
}

async function main(): Promise<void> {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })

  const project = await importHandoffPackage(FIXTURE, { projectsRoot: join(WORK, 'projects') })
  const clip = project.clips[0]
  assert.equal(clip.broll.length, 1)
  const insert = clip.broll[0]
  assert.equal(insert.kind, 'video')
  assert.ok(project.transcript && project.transcript.segments.length > 0, 'transcript mapped')
  console.log(`✓ imported "${project.name}": ${project.video.durationSec.toFixed(2)}s, insert ${insert.start}–${insert.end}s from ${insert.mediaIn}s`)

  for (const tighten of [false, true]) {
    const out = join(WORK, `render${tighten ? '-tightened' : ''}.mp4`)
    await renderClip({
      clip: { ...clip, edit: { ...clip.edit, tightenCuts: tighten } },
      source: project.video,
      transcript: project.transcript,
      outputPath: out,
      encoder: 'cpu',
      quality: 'draft'
    })
    const rendered = await probeVideo(out)
    assert.equal(rendered.width, 1080)
    assert.equal(rendered.height, 1920)
    assert.ok(rendered.hasAudio, 'render has audio')
    if (tighten) {
      // The fixture's speech has no pause worth cutting; this proves the
      // trim+concat path accepts a protected video insert.
      console.log(`✓ render with pause removal on: ${rendered.durationSec.toFixed(2)}s`)
      continue
    }
    assert.ok(Math.abs(rendered.durationSec - project.video.durationSec) < 0.2, `duration ${rendered.durationSec}`)

    // Past the 0.25 s fade-in, through to before the fade-out.
    for (const t of [insert.start + 0.35, (insert.start + insert.end) / 2, insert.end - 0.35]) {
      const colour = await topColour(out, t)
      assert.ok(isRed(colour), `insert footage from mediaIn at ${t.toFixed(2)}s (got rgb ${colour.join(',')})`)
    }
    for (const t of [0.5, insert.start - 0.4, insert.end + 0.4, project.video.durationSec - 0.5]) {
      const colour = await topColour(out, t)
      assert.ok(!isRed(colour), `A-roll at ${t.toFixed(2)}s (got rgb ${colour.join(',')})`)
    }
    console.log('✓ insert covers its span with footage from mediaIn; A-roll before and after')

    const under = await meanVolume(out, insert.start, insert.end - insert.start)
    const before = await meanVolume(out, 0.5, 1.2)
    assert.ok(under > -35, `A-roll audio under the insert (${under} dB)`)
    assert.ok(Math.abs(under - before) < 6, `audio level steady across the insert (${before} → ${under} dB)`)
    console.log(`✓ A-roll audio continues under the insert (${before.toFixed(1)} → ${under.toFixed(1)} dB)`)
  }

  console.log('\nAll handoff tests passed.')
}

main().catch((err) => {
  console.error('\nHandoff test FAILED:', err)
  process.exit(1)
})
