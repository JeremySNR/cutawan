import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useStore } from '../store'

/**
 * Settings: whether new runs are re-ranked from the clips this user exports
 * and edits (see shared/personalisation.ts), with a reset.
 */
export default function PersonalisationSettings(): React.JSX.Element {
  const summary = useStore((s) => s.personalisation)
  const refresh = useStore((s) => s.refreshPersonalisation)
  const setEnabled = useStore((s) => s.setPersonalisationEnabled)
  const reset = useStore((s) => s.resetPersonalisation)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const enabled = summary?.enabled ?? true
  const status = !summary
    ? ''
    : !summary.enabled
      ? 'Off. Clips are ranked by the AI scores alone.'
      : summary.active
        ? `On. Learned from ${summary.positives} clips you exported or edited.`
        : `Learning: ${summary.positives} of ${summary.minPositives} exported or edited clips so far.`

  return (
    <div className="mt-5" data-testid="personalisation-settings">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Sparkles size={15} className="text-accent-400" />
        Learn from my choices
      </label>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        Cutawan notes which clips you export or edit, and slightly re-ranks new runs towards
        the kind of clip and length you keep. It never changes the AI&apos;s scores for each part.
        Stored only on this computer.
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="personalisation-toggle"
          onClick={() => void setEnabled(!enabled)}
          className="flex flex-1 items-center justify-between gap-3 rounded-xl border border-surface-600 px-3.5 py-2.5 text-left text-xs text-zinc-300 transition hover:bg-surface-800"
        >
          <span>{status || 'Personalised ranking'}</span>
          <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${enabled ? 'bg-zinc-100' : 'bg-surface-600'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${enabled ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'}`} />
          </span>
        </button>
        <button
          type="button"
          disabled={!summary || summary.recorded === 0}
          onClick={() => {
            if (!confirming) {
              setConfirming(true)
              return
            }
            setConfirming(false)
            void reset()
          }}
          onBlur={() => setConfirming(false)}
          className="shrink-0 rounded-xl border border-surface-600 px-3.5 py-2.5 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-40"
        >
          {confirming ? 'Forget everything?' : 'Reset'}
        </button>
      </div>
    </div>
  )
}
