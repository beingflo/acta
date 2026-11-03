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

/** The hue every source shares in the firehose bar chart: the chart green, so a
 *  stack of sources still reads as the system's data divided up rather than as a
 *  handful of unrelated quantities. */
const SOURCE_HUE = 150
/** The ramp's ends: dark enough that the lowest band is a band, light enough at
 *  the top that ten of them still differ without any going pale enough to vanish
 *  against the card. */
const SOURCE_DARK = 24
const SOURCE_LIGHT = 62

/**
 * Fills for `present`, aligned to it: shades of the chart green, ranked by name
 * over the roster of every source the dataset holds, darkest first.
 *
 * A hue each would say less than it looks: the sources are not six quantities
 * but one firehose divided up, and the tooltip names every band anyway. Shades
 * say it the way a legend of one colour does.
 *
 * A source's shade is a function of the roster alone — not of the selected
 * window, not of how much it sent, not of which other sources happen to be
 * present — so a band can be followed from one range to the next, which is the
 * only thing a shade is for. `roster` is that list, read once from the dataset;
 * a source in `present` but not in the roster yet (it started since the page
 * loaded) still takes a place, at the end of the alphabet.
 *
 * The ramp is spread over the roster rather than stepped at a fixed rate,
 * because a shade a few percent off its neighbour is no shade at all. That makes
 * the steps narrower as the roster grows — a dozen collectors would leave about
 * four percent between neighbours, which is where the tooltip starts doing the
 * work instead.
 */
export function sourceFills(present: readonly string[], roster: readonly string[]): string[] {
  if (present.length === 0) return []
  const ranked = [...new Set([...roster, ...present])].sort()
  const span = Math.max(ranked.length - 1, 1)
  return present.map((source) => {
    const at = ranked.indexOf(source) / span
    const lightness = Math.round(SOURCE_DARK + at * (SOURCE_LIGHT - SOURCE_DARK))
    const saturation = Math.round(46 - at * 16)
    return `hsl(${SOURCE_HUE}, ${saturation}%, ${lightness}%)`
  })
}

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
