import { describe, expect, it } from 'vitest'
import { balanceLines, planTitle, TITLE_SHOW_SEC, titleTop } from '@shared/titleLayout'
import { DEFAULT_BRAND_COLORS, getCaptionStyle } from '@shared/captionStyles'

const beast = getCaptionStyle('beast')
const base = { captionStyle: beast, aspectRatio: 9 / 16, start: 0, duration: 30 }

describe('balancing title lines', () => {
  it('uses the fewest lines, then the most even split', () => {
    // Widths in em; the limit fits about two short words per line.
    expect(balanceLines([2, 2, 2, 2], 6, 3)).toEqual([[0, 1], [2, 3]])
    expect(balanceLines([1, 1], 6, 3)).toEqual([[0, 1]])
    expect(balanceLines([4, 1, 1, 4], 6.6, 3)).toEqual([[0, 1], [2, 3]])
  })
  it('reports when nothing fits', () => {
    expect(balanceLines([9], 6, 3)).toBeNull()
  })
})

describe('planning the hook title', () => {
  it('balances a long hook over lines inside the top safe area', () => {
    const plan = planTitle('This is how creators actually blow up on short form video', base)!
    expect(plan.lines.length).toBeGreaterThan(1)
    expect(plan.lines.length).toBeLessThanOrEqual(3)
    const lengths = plan.lines.map((l) => l.map((w) => w.text).join(' ').length)
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(10)
    expect(plan.top).toBe(titleTop(9 / 16))
    expect(plan.end - plan.start).toBe(TITLE_SHOW_SEC)
  })

  it('appears after a cold open and never outlasts the clip', () => {
    const plan = planTitle('The hook', { ...base, start: 2.4, duration: 5 })!
    expect(plan.start).toBe(2.4)
    expect(plan.end).toBe(5)
  })

  it('offers three looks drawn from the caption style', () => {
    const card = planTitle('Ten million views in a week', base)!
    expect(card.boxColor).toBe('#000000')
    expect(card.boxOpacity).toBe(0.75)
    const bold = planTitle('Ten million views in a week', { ...base, styleId: 'bold' })!
    expect(bold.boxColor).toBeNull()
    expect(bold.lines.flat().map((w) => w.text).join(' ')).toBe('TEN MILLION VIEWS IN A WEEK')
    expect(bold.lines.flat().filter((w) => w.accent)).toHaveLength(1)
    expect(bold.accentColor).toBe(beast.highlightColor)
    const banner = planTitle('Ten million views', { ...base, styleId: 'banner' })!
    expect(banner.boxColor).toBe(beast.highlightColor)
    expect(banner.boxOpacity).toBe(1)
    // Yellow box: dark text.
    expect(banner.textColor).toBe('#111111')
  })

  it('takes brand colours for the card', () => {
    const brand = { ...DEFAULT_BRAND_COLORS, enabled: true, hookTextColor: '#FF0000', hookBackgroundColor: '#00FF00' }
    const plan = planTitle('Hook', { ...base, brandColors: brand })!
    expect(plan.textColor).toBe('#FF0000')
    expect(plan.boxColor).toBe('#00FF00')
  })

  it('shrinks a very long hook before giving it a fourth line', () => {
    const plan = planTitle('one two three four five six seven eight nine ten eleven twelve thirteen fourteen', base)!
    expect(plan.fontScale).toBeLessThan(0.044)
  })

  it('has nothing to show for an empty hook', () => {
    expect(planTitle('   ', base)).toBeNull()
  })
})
