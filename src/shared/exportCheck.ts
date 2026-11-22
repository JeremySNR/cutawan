import type { ExportCheckReport } from './types'

/**
 * How an export's check reads in the UI: a short label beside the saved
 * file ("Checked", "1 issue", "Fixed 1") and the details for its tooltip.
 * Repaired findings are not issues: the saved file no longer has them, but
 * they are listed so a trimmed second or a level change is not a surprise.
 */
export interface ExportCheckSummary {
  label: string
  /** Unrepaired findings. */
  issues: number
  repaired: number
  /** One line per finding, for a tooltip. */
  detail: string
}

export function exportCheckSummary(report: ExportCheckReport | undefined): ExportCheckSummary | null {
  if (!report) return null
  if (report.status === 'skipped') {
    return { label: 'Not checked', issues: 0, repaired: 0, detail: report.note ?? 'The check after export could not run.' }
  }
  const issues = report.findings.filter(f => !f.repaired)
  const repaired = report.findings.filter(f => f.repaired)
  const label = issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}`
    : repaired.length ? `Fixed ${repaired.length}` : 'Checked'
  const lines = [
    ...issues.map(f => f.message),
    ...repaired.map(f => f.message)
  ]
  if (!lines.length) lines.push('No black frames, frozen picture, dead air, level problems or cuts inside words.')
  if (report.loudness) {
    lines.push(`Loudness ${report.loudness.integratedLufs.toFixed(1)} LUFS, peak ${report.loudness.truePeakDb.toFixed(1)} dBTP.`)
  }
  return { label, issues: issues.length, repaired: repaired.length, detail: lines.join('\n') }
}

/** "0:07" or "1:02:07", for placing a finding in the exported file. */
export function formatCheckTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
