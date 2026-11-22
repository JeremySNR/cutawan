/**
 * Offline check that burned-in captions come out the size the live preview
 * shows. The two use different units — CSS `font-size` sets the em square,
 * libass `Fontsize` sets the OS/2 window ascent+descent span — so this renders
 * a real frame through libass and measures the ink against what the preview's
 * CSS would produce for the same style.
 *
 * Makes no API calls. Run with:
 *   npx tsx --tsconfig tsconfig.node.json scripts/test-captionsize.ts
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { buildAss } from '../src/main/pipeline/captions'
import { parseFontMetrics } from '../src/main/fonts'
import { CAPTION_STYLES } from '../src/shared/captionStyles'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import type { Transcript } from '../src/shared/types'

const WORK = join(process.cwd(), '.tmp', 'captionsize-test')
const W = 1080
const H = 1920
/** Caps-only word, so measured ink height is exactly the cap height. */
const WORD = 'HEIGHT'
/** Antialiased edges inflate a naive measurement; allow a little slack. */
const TOLERANCE = 0.08

function transcript(): Transcript {
  return {
    language: 'en',
    durationSec: 5,
    segments: [{ id: 0, start: 0, end: 5, text: WORD, words: [{ text: WORD, start: 0, end: 5 }] }]
  }
}

/** Cap height in font units, from the OS/2 table (sCapHeight, version >= 2). */
async function capHeightEm(file: string): Promise<number> {
  const buf = await readFile(file)
  const numTables = buf.readUInt16BE(4)
  let os2 = -1
  let head = -1
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = buf.toString('latin1', rec, rec + 4)
    if (tag === 'OS/2') os2 = buf.readUInt32BE(rec + 8)
    if (tag === 'head') head = buf.readUInt32BE(rec + 8)
  }
  const upem = buf.readUInt16BE(head + 18)
  return buf.readInt16BE(os2 + 88) / upem
}

/** Escape a path for use inside an ffmpeg filter argument. */
function esc(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function run(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      windowsHide: true
    })
    const out: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))
    )
  })
}

/**
 * Height in pixels of the glyph itself, matched by colour.
 *
 * Deliberately not a brightness threshold: the active word is drawn with a fat
 * `\bord10` outline in the pill colour on some styles, so a bright pill gets
 * measured as part of the letterform and inflates the result.
 */
async function renderedInkHeight(assPath: string, glyphHex: string): Promise<number> {
  const raw = await run([
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}`,
    '-frames:v', '1',
    // Same escaping the real render uses: a Windows drive colon would
    // otherwise terminate the filter option.
    '-vf', `ass=filename='${esc(assPath)}':fontsdir='${esc('resources/fonts')}'`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'
  ])
  const hex = glyphHex.replace('#', '')
  const want = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  let top = -1
  let bottom = -1
  for (let y = 0; y < H; y++) {
    let ink = false
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3
      if (
        Math.abs(raw[p] - want[0]) < 40 &&
        Math.abs(raw[p + 1] - want[1]) < 40 &&
        Math.abs(raw[p + 2] - want[2]) < 40
      ) {
        ink = true
        break
      }
    }
    if (ink) {
      if (top < 0) top = y
      bottom = y
    }
  }
  return top < 0 ? 0 : bottom - top + 1
}

/** Is this glyph colour far enough from a black frame to measure reliably? */
function isMeasurableOnBlack(hex: string): boolean {
  const h = hex.replace('#', '')
  return [0, 2, 4].some((i) => parseInt(h.slice(i, i + 2), 16) > 96)
}

const FONT_FILES: Record<string, string> = {
  Anton: 'resources/fonts/Anton-Regular.ttf',
  Poppins: 'resources/fonts/Poppins-Bold.ttf',
  'Poppins Medium': 'resources/fonts/Poppins-Medium.ttf'
}

async function main(): Promise<void> {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })

  let checked = 0
  const skipped: string[] = []
  for (const style of CAPTION_STYLES) {
    // Animated styles are drawn by canvas at the CSS em size in both the
    // preview and the export (scripts/test-animated-captions.sh checks them);
    // libass only burns their fallback preset, which is measured on its own.
    if (style.animation) continue
    const file = FONT_FILES[style.fontFamily]
    if (!file) continue
    // Measuring optically means the glyph colour has to stand apart from the
    // black frame. A dark-on-pill style (lemon) cannot be measured this way;
    // `assFontSize` is unit-tested exactly instead. Skipped out loud, never
    // silently, so a real regression cannot hide behind a skip.
    if (!isMeasurableOnBlack(style.highlightColor)) {
      skipped.push(style.id)
      continue
    }
    const buf = await readFile(file)
    const metrics = parseFontMetrics(buf)
    assert.ok(metrics, `${style.fontFamily}: metrics must parse`)

    const assPath = join(WORK, `${style.id}.ass`)
    await writeFile(
      assPath,
      buildAss(transcript(), {
        styleId: style.id,
        width: W,
        height: H,
        clipStart: 0,
        clipEnd: 5,
        fontMetrics: metrics
      }),
      'utf8'
    )

    // What the preview draws: CSS font-size is the em square, so the visible
    // cap height is the font's capHeight fraction of it.
    const cssEmPx = style.fontScale * H
    const expected = cssEmPx * (await capHeightEm(file))
    // The single word in the fixture is the active one, so it is drawn in the
    // style's highlight colour rather than its base text colour.
    const actual = await renderedInkHeight(assPath, style.highlightColor)
    const ratio = actual / expected

    console.log(
      `${style.id.padEnd(9)} ${style.fontFamily.padEnd(15)} ` +
        `preview ${expected.toFixed(1)}px  export ${actual}px  ratio ${ratio.toFixed(3)}`
    )
    assert.ok(
      Math.abs(ratio - 1) <= TOLERANCE,
      `${style.id}: export is ${(ratio * 100).toFixed(0)}% of the preview size, should be ~100%`
    )
    checked++
  }

  assert.ok(checked >= 6, 'expected to measure most styles')
  console.log(`\nAll ${checked} measured caption styles render at preview size.`)
  if (skipped.length > 0) {
    console.log(`Not optically measurable (dark glyph on a black frame): ${skipped.join(', ')}`)
    console.log('Those are covered exactly by the assFontSize unit tests.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
