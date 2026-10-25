/** Chart colors: one green hue for every series, so all tiles read as one family. */

import type uPlot from 'uplot'

const HUE = 150

export const STROKE = `hsl(${HUE}, 28%, 40%)`

/** The location track is ink, not a series: graphite, edged in white below so
 *  it stays legible over the basemap's busy street detail. */
export const TRACK = '#1F2937'
export const TRACK_CASING = '#ffffff'

/** Flat fill for bar charts: `fillFor` builds a gradient, which only reads well
 *  under a line. Dark enough that a run of bars reads as one solid mass, while
 *  the line charts' wash stays the lightest thing in the palette. */
export const BAR_FILL = `hsla(${HUE}, 30%, 30%, 0.85)`

/** Marending stacks what got through under what the handler rejected: a deeper
 *  green than the shared fill, and red for the rejected slice. */
export const BAR_OK_FILL = `hsla(${HUE}, 32%, 32%, 0.85)`
export const BAR_ERROR_FILL = 'hsla(0, 55%, 44%, 0.8)'

/** Faint wash of the hue under the curve, fading towards the baseline. */
export const fillFor = (self: uPlot): CanvasGradient => {
  const gradient = self.ctx.createLinearGradient(0, 0, 0, self.bbox.height)
  gradient.addColorStop(0, `hsla(${HUE}, 35%, 45%, 0.14)`)
  gradient.addColorStop(1, `hsla(${HUE}, 35%, 45%, 0.02)`)
  return gradient
}
