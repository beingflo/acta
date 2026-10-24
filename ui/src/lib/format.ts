/** Number and timestamp formatting shared by the tooltips, the summary cards
 *  and the time axes. */

const pad = (value: number, digits = 2) => String(value).padStart(digits, '0')

/** Trim to a readable precision: 1013.2, 21.23, 452. */
export function formatNumber(value: number): string {
  const digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 1 : 2
  const fixed = value.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** Local time, at the detail the selected window can support: a multi-year
 *  window needs a date, a window of milliseconds needs its milliseconds. */
export function formatTimestamp(seconds: number, spanMs: number): string {
  const date = new Date(seconds * 1000)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (spanMs > 30 * 86_400_000) return day
  let clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (spanMs <= 3_600_000) clock += `:${pad(date.getSeconds())}`
  if (spanMs <= 2_000) clock += `.${pad(date.getMilliseconds(), 3)}`
  return `${day} ${clock}`
}

/** The `[ppm]` part of a y-label, if it has one. */
export function unitOf(yLabel?: string): string {
  const match = yLabel?.match(/\[([^\]]+)\]/)
  return match ? match[1] : ''
}

const DAY = 86_400
const HOUR = 3_600
const MINUTE = 60
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A tick unit whose change earns the tick a second label line. */
type Unit = 'year' | 'day' | 'hour' | 'minute'

const UNIT_OF: Record<Unit, (date: Date) => number> = {
  year: (date) => date.getFullYear(),
  day: (date) => date.getDate(),
  hour: (date) => date.getHours(),
  minute: (date) => date.getMinutes(),
}

const UNITS = Object.keys(UNIT_OF) as Unit[]

/** Day first, the way the axis should read: 06/11, or 06/11/2026. */
const dayFirst = (date: Date, withYear = false) =>
  `${pad(date.getDate())}/${pad(date.getMonth() + 1)}${withYear ? `/${date.getFullYear()}` : ''}`
const clock = (date: Date) =>
  `${date.getHours() % 12 || 12}:${pad(date.getMinutes())}${date.getHours() < 12 ? 'am' : 'pm'}`
const hourOfDay = (date: Date) =>
  `${date.getHours() % 12 || 12}${date.getHours() < 12 ? 'am' : 'pm'}`

/**
 * uPlot spells its date ticks month-first (`10/10/26`) and there is no setting
 * for the order, only `axis.values`. These labels mirror its rollover scheme —
 * the tick format depends on the tick spacing, and a tick that starts a larger
 * unit gets that unit on a second line — with day-first dates.
 */
export function axisTickLabels(splits: number[], spacingSeconds: number): string[] {
  const stamp = stampFor(spacingSeconds)
  const previous = new Map<Unit, number>()
  return splits.map((seconds) => {
    const date = new Date(seconds * 1000)
    const rollover = stamp.rollover.find(([unit]) => UNIT_OF[unit](date) !== previous.get(unit))
    for (const unit of UNITS) previous.set(unit, UNIT_OF[unit](date))
    const label = stamp.label(date)
    return rollover ? `${label}\n${rollover[1](date)}` : label
  })
}

/** Tick labels and the rollovers that accompany them, by tick spacing. */
function stampFor(spacing: number): {
  label: (date: Date) => string
  rollover: [Unit, (date: Date) => string][]
} {
  if (spacing >= 365 * DAY) return { label: (d) => String(d.getFullYear()), rollover: [] }
  if (spacing >= 28 * DAY) {
    return {
      label: (d) => MONTHS[d.getMonth()],
      rollover: [['year', (d) => String(d.getFullYear())]],
    }
  }
  if (spacing >= DAY) {
    return { label: (d) => dayFirst(d), rollover: [['year', (d) => String(d.getFullYear())]] }
  }
  // A date is enough to identify a tick a day or more apart; closer in, the
  // clock is the label and the date is only spelled out where the day turns
  // over, which keeps the ticks narrow.
  if (spacing >= HOUR) {
    return {
      label: hourOfDay,
      rollover: [
        ['year', (d) => dayFirst(d, true)],
        ['day', (d) => dayFirst(d)],
      ],
    }
  }
  if (spacing >= MINUTE) {
    return {
      label: clock,
      rollover: [
        ['year', (d) => dayFirst(d, true)],
        ['day', (d) => dayFirst(d)],
      ],
    }
  }
  const millis = spacing < 1
  return {
    label: (d) => `:${pad(d.getSeconds())}${millis ? `.${pad(d.getMilliseconds(), 3)}` : ''}`,
    rollover: [
      ['year', (d) => `${dayFirst(d, true)} ${clock(d)}`],
      ['day', (d) => `${dayFirst(d)} ${clock(d)}`],
      ['minute', clock],
    ],
  }
}
