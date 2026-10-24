/** Number and timestamp formatting shared by the tooltips and the summary cards. */

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
  const pad = (part: number, digits = 2) => String(part).padStart(digits, '0')
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
