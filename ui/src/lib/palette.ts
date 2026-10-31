/** Chart colors: a dark green for the data, plus a short ordered set of other
 *  dark colors for the rare tile that draws more than one series. */

import type uPlot from 'uplot'

/**
 * Line colors by series index, in a fixed order: green for every single-series
 * chart (and for the first series of a multi-series one), then a much darker
 * green, then blue and plum for the rare tile with more series than that.
 *
 * Two rules decide them. They are dark — a 1px line in a light tint disappears
 * against the white card, and the green used to sit at 40% lightness, which read
 * as a faded copy of itself. And the second is darker rather than a different
 * hue: the two temperatures from two sensors are the same quantity, and a second
 * hue made the pair read as two different measurements instead of two readings
 * of one. Dark enough at 17% lightness to be told apart from the base shade, in
 * the line and in the tooltip's 7px swatch.
 */
const STROKES: [number, number, number][] = [
  [150, 32, 30], // green
  [150, 46, 17], // darker green
  [205, 60, 38], // blue
  [285, 42, 40], // plum
]

/** Line colour for a series, from the fixed order above. */
export const strokeFor = (index: number) => {
  const [hue, saturation, lightness] = STROKES[index % STROKES.length]
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

/** The location track is ink, not a series: plain black, so it reads as a track
 *  over the basemap rather than as one more data line. */
export const TRACK = '#000000'

/** Flat fill for bar charts: `fillFor` builds a gradient, which only reads well
 *  under a line. Dark enough that a run of bars reads as one solid mass, while
 *  the line charts' wash stays the lightest thing in the palette. */
export const BAR_FILL = 'hsla(150, 30%, 30%, 0.85)'

/** Marending stacks what got through under what the handler rejected: a deeper
 *  green than the shared fill, and red for the rejected slice. */
export const BAR_OK_FILL = 'hsla(150, 32%, 32%, 0.85)'
export const BAR_ERROR_FILL = 'hsla(0, 55%, 44%, 0.8)'

/**
 * Faint wash of the series' hue under its curve, fading towards the baseline.
 * Every series gets one; a darker series' wash is darker, so the band under it
 * is the series' own tone rather than a second colour mixed in.
 *
 * uPlot can ask for a series' fill before the plot has been measured — it builds
 * its legend inside its constructor, for instance — and a gradient to `NaN`
 * throws. There is no height to fade over yet, so the caller gets the top colour
 * of the wash instead.
 */
export const fillFor = (self: uPlot, uSeriesIdx: number): CanvasGradient | string => {
  // uPlot's series index is 1-based: its series 0 is the x axis, so the first
  // drawn series arrives here as 1.
  const [hue, saturation, lightness] = STROKES[(uSeriesIdx - 1) % STROKES.length]
  const top = `hsla(${hue}, ${saturation + 6}%, ${lightness + 14}%, 0.12)`
  const fade = `hsla(${hue}, ${saturation + 6}%, ${lightness + 14}%, 0.02)`
  if (!Number.isFinite(self.bbox?.height)) return top
  const gradient = self.ctx.createLinearGradient(0, 0, 0, self.bbox.height)
  gradient.addColorStop(0, top)
  gradient.addColorStop(1, fade)
  return gradient
}
