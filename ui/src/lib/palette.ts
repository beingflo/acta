/** Chart colors: one green hue for every series, so all tiles read as one family. */

import type uPlot from 'uplot'

const HUE = 150

export const STROKE = `hsl(${HUE}, 28%, 40%)`

/** Faint wash of the hue under the curve, fading towards the baseline. */
export const fillFor = (self: uPlot): CanvasGradient => {
  const gradient = self.ctx.createLinearGradient(0, 0, 0, self.bbox.height)
  gradient.addColorStop(0, `hsla(${HUE}, 35%, 45%, 0.14)`)
  gradient.addColorStop(1, `hsla(${HUE}, 35%, 45%, 0.02)`)
  return gradient
}
