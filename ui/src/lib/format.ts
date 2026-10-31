/** Number and timestamp formatting shared by the tooltips, the summary cards
 *  and the time axes. */

const pad = (value: number, digits = 2) => String(value).padStart(digits, '0')

/** Trim to a readable precision: 1013.2, 21.23, 452. */
export function formatNumber(value: number): string {
  const digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 1 : 2
  const fixed = value.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** Large counts in a card-sized form: 9893 as 9.89k, 6828129 as 6.83M. */
export function formatCompact(value: number): string {
  const units = ['', 'k', 'M', 'B']
  let scaled = Math.abs(value)
  let unit = 0
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000
    unit++
  }
  const digits = scaled >= 100 ? 0 : 2
  const fixed = scaled.toFixed(digits)
  const text = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return `${value < 0 ? '-' : ''}${text}${units[unit]}`
}

/** Bytes split into a number and its unit, for a card's two-part value:
 *  `{ value: '63.3', unit: 'MB' }`. */
export function byteParts(bytes: number): { value: string; unit: string } {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let scaled = Math.abs(bytes)
  let unit = 0
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000
    unit++
  }
  const digits = unit === 0 || scaled >= 100 ? 0 : 1
  return { value: `${bytes < 0 ? '-' : ''}${scaled.toFixed(digits)}`, unit: units[unit] }
}

/** MiB as a card's two-part byte value, the unit the collectors report memory
 *  in: `{ value: '3.7', unit: 'GB' }`. */
export function mibParts(mib: number): { value: string; unit: string } {
  return byteParts(mib * 1024 ** 2)
}

/** A duration in milliseconds split into a number and its unit, for the stats
 *  strip and the request table: `{ value: '1.3', unit: 's' }`. */
export function latencyParts(ms: number | null): { value: string; unit: string } | null {
  if (ms === null || !Number.isFinite(ms)) return null
  if (ms >= 1_000) {
    return { value: (ms / 1_000).toFixed(1).replace(/\.0$/, ''), unit: 's' }
  }
  return { value: ms >= 100 ? ms.toFixed(0) : ms.toFixed(1), unit: 'ms' }
}

/** A duration in seconds as the age of a timestamp: 32 s, 4 min, 3 h, 2 d. */
export function formatAge(seconds: number): string {
  const value = Math.max(0, seconds)
  if (value < 60) return `${Math.round(value)} s`
  if (value < 3_600) return `${Math.round(value / 60)} min`
  if (value < 86_400) return `${Math.round(value / 3_600)} h`
  return `${Math.round(value / 86_400)} d`
}

/** A window length in the shortest form that still reads: 45s, 12m, 3h, 4d,
 *  3mo, 1y. Rounded hard on purpose — it answers "how much am I looking at",
 *  while the two datetime fields beside it already say exactly which window. */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000
  if (seconds < 90) return `${Math.round(seconds)}s`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 36) return `${Math.round(hours)}h`
  const days = hours / 24
  if (days < 60) return `${Math.round(days)}d`
  // Months and years are calendar-flavoured averages, which is all this label
  // is: 30.44 days a month and 365 a year.
  if (days < 365) return `${Math.round(days / 30.44)}mo`
  const years = days / 365
  return `${years < 10 ? Math.round(years * 10) / 10 : Math.round(years)}y`
}

/** A bucket width for a bar chart's subtitle: 500 ms, 30 s, 5 min, 6 h, 2 d. */
export function formatBucket(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`
  return `${Math.round(ms / 86_400_000)} d`
}

/** Local time, at the detail the selected window can support: a window of
 *  milliseconds needs its milliseconds. The clock is always part of it, however
 *  wide the window — a tooltip that only names the day leaves the reader guessing
 *  which hour of it they are pointing at. */
export function formatTimestamp(seconds: number, spanMs: number): string {
  const date = new Date(seconds * 1000)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  let clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (spanMs <= 3_600_000) clock += `:${pad(date.getSeconds())}`
  if (spanMs <= 2_000) clock += `.${pad(date.getMilliseconds(), 3)}`
  return `${day} ${clock}`
}

/** `DD-MM-YYYY` and `HH:MM:SS` in local time, from microseconds since the
 *  epoch, day first like the chart axes. The paged tables render the two parts
 *  separately: the date is the first thing to go on a narrow screen. */
export function tableTimeParts(us: number): { day: string; clock: string } {
  const date = new Date(Math.floor(us / 1000))
  return {
    day: `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`,
    clock: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  }
}

/** `HH:MM` in local time, for a time of day rather than an instant. */
export function formatClock(seconds: number): string {
  const date = new Date(seconds * 1000)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
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
