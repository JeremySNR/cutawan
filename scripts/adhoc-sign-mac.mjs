/**
 * electron-builder afterPack hook: ad-hoc signs the packaged macOS app.
 *
 * We have no Developer ID yet, so electron-builder's own signing is off
 * (`mac.identity: null`). Packaging edits the bundle after Electron's original
 * signature was made, which leaves it invalid, and macOS on Apple Silicon then
 * reports a downloaded copy as "damaged" with no way to open it. An ad-hoc
 * signature keeps the bundle intact, so Gatekeeper shows its usual
 * unidentified-developer prompt and Privacy & Security → Open Anyway works.
 *
 * electron-builder 25 cannot ad-hoc sign itself (identity "-" arrived in 26).
 * It runs this hook before building the dmg/zip, so both carry the signed app.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export default async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed  ${app}`)
}
