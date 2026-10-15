/** Per-metric colors: the same quantity reads the same on every dashboard. */

import type uPlot from 'uplot'

export type Metric = 'temperature' | 'humidity' | 'co2' | 'pressure' | 'brightness' | 'visitors'

/** Warm for temperature, cool for humidity, etc. */
const HUES: Record<Metric, number> = {
  temperature: 18,
  humidity: 205,
  co2: 150,
  pressure: 265,
  brightness: 45,
  visitors: 330,
}

export const strokeFor = (metric: Metric): string => `hsl(${HUES[metric]}, 28%, 40%)`

/** Faint wash of the series hue under the curve, fading towards the baseline. */
export const fillFor = (metric: Metric): ((self: uPlot) => CanvasGradient) => {
  const hue = HUES[metric]
  return (self) => {
    const gradient = self.ctx.createLinearGradient(0, 0, 0, self.bbox.height)
    gradient.addColorStop(0, `hsla(${hue}, 35%, 45%, 0.14)`)
    gradient.addColorStop(1, `hsla(${hue}, 35%, 45%, 0.02)`)
    return gradient
  }
}
