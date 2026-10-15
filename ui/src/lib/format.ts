/** Number and timestamp formatting shared by the tooltips and the summary cards. */

/** Trim to a readable precision: 1013.2, 21.23, 452. */
export function formatNumber(value: number): string {
  const digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 1 : 2
  const fixed = value.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** Local time, matching what uPlot's time axis shows. */
export function formatTimestamp(seconds: number, dateOnly: boolean): string {
  const date = new Date(seconds * 1000)
  const pad = (part: number) => String(part).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return dateOnly ? day : `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The `[ppm]` part of a y-label, if it has one. */
export function unitOf(yLabel?: string): string {
  const match = yLabel?.match(/\[([^\]]+)\]/)
  return match ? match[1] : ''
}
