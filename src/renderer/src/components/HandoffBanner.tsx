import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useStore } from '../store'

/**
 * Rights as Metachlorian decided them for an imported package. Any verdict
 * but "allowed" stays on screen for as long as the project is open: Cutawan
 * neither overrides that decision nor hides it. Required credits are shown
 * whatever the verdict, because publishing without them breaks the licence.
 */
export default function HandoffBanner({ className = '' }: { className?: string }): React.JSX.Element | null {
  const handoff = useStore((s) => s.project?.handoff)
  if (!handoff) return null
  const { verdict, credits, reasons, earliestExpiry } = handoff.rights
  const allowed = verdict === 'allowed'
  if (allowed && credits.length === 0 && !handoff.notes?.length) return null

  const tone = verdict === 'blocked'
    ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : allowed
      ? 'border-surface-600 bg-surface-850 text-zinc-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
  const Icon = allowed ? ShieldCheck : ShieldAlert
  const headline = verdict === 'blocked'
    ? 'Rights: blocked. Do not publish this footage.'
    : verdict === 'restricted'
      ? 'Rights: restricted. Check the conditions before publishing.'
      : verdict === 'unknown'
        ? 'Rights: unknown. Some footage has no rights record.'
        : allowed
          ? 'Rights: cleared for the intended use.'
          : `Rights: ${verdict}.`

  return (
    <div
      data-testid="handoff-banner"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-xs leading-relaxed ${tone} ${className}`}
    >
      <Icon size={17} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-semibold">{headline}</div>
        {!allowed && reasons && reasons.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 opacity-90">
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
        {credits.length > 0 && (
          <div className="opacity-90">
            <span className="font-medium">Credit required: </span>
            {credits.join('; ')}
          </div>
        )}
        {earliestExpiry && (
          <div className="opacity-90">
            <span className="font-medium">Licence expires: </span>
            {earliestExpiry}
          </div>
        )}
        {handoff.notes?.map((note) => <div key={note} className="opacity-75">{note}</div>)}
        <div className="opacity-60">
          From Metachlorian package {handoff.packageName ? `“${handoff.packageName}” ` : ''}({handoff.packageId}). The package’s RIGHTS.md has the detail.
        </div>
      </div>
    </div>
  )
}
