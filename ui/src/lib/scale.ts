/** How a chart's y axis is fitted to its data. */

import type uPlot from 'uplot'

/**
 * A y axis fitted to the data, with the room a chart needs not to lie.
 *
 * uPlot's default is the data's own extent plus ten percent of headroom, so a
 * resource that idles near zero hugs the bottom of the tile and a series that
 * barely moves fills the whole height — the shape of the noise, not of the
 * quantity. A fit says what the axis may show instead:
 *
 * - `floor` / `ceiling`: the values the quantity cannot leave. A percentage is
 *   0-100; a rate has a floor of zero but no ceiling; a temperature has
 *   neither.
 * - `pad`: headroom above and below the data, as a fraction of the data's own
 *   extent. A fifth leaves room for the next spike without hiding the trend.
 * - `span`: the narrowest axis worth drawing, in the quantity's units. A
 *   constant reading then sits as a flat line across the middle of a sensible
 *   window rather than being magnified into a saw of rounding noise.
 *
 * The bounds are not rounded outward to whole ticks: the axis edge need not be
 * a labelled tick, and rounding a narrow span up to the next tick step would
 * undo the fit (a memory chart rounded to 1000 MB steps spends a quarter of its
 * height on nothing).
 */
export type YFit = {
  floor?: number
  ceiling?: number
  pad?: number
  span?: number
}

/** A share of a fixed capacity: CPU, memory, disk, battery charge. */
export const PERCENT: YFit = { floor: 0, ceiling: 100, pad: 0.2, span: 5 }

/**
 * A share of the host's cores, which `podman stats` reports per core: a
 * container busy on four of eight cores is 400%, so only the floor applies.
 */
export const SHARE: YFit = { floor: 0, pad: 0.2, span: 5 }

/** Degrees, for a component whose idle temperature barely moves. */
export const TEMPERATURE: YFit = { pad: 0.2, span: 4 }

/** A rate or a per-bucket count: zero is real, and quiet is the normal state. */
export const RATE: YFit = { floor: 0, pad: 0.2, span: 10 }

/** A load average, which idles at a fraction of a runnable task. */
export const LOAD: YFit = { floor: 0, pad: 0.2, span: 2 }

/**
 * Turn a fit into a uPlot y range function.
 *
 * The order matters: pad the data, widen it to the minimum span, then clamp to
 * the quantity's bounds — so a percentage that peaked at 97 still shows its
 * full 0-100 while a quiet one is allowed to zoom in. A clamp can eat the span
 * again (there is nowhere to grow inside 100), so the last step takes the room
 * back from the other end, where there is any.
 */
export function fitRange(fit: YFit) {
  const { floor, ceiling, pad = 0.2, span = 0 } = fit
  return (_self: uPlot, min: number | null, max: number | null): [number, number] => {
    // An empty window passes no bounds: keep the axis on the quantity's own
    // scale rather than collapsing it, so it does not jump while loading.
    if (min == null || max == null) {
      return [floor ?? 0, ceiling ?? (floor ?? 0) + (span || 1)]
    }
    let low = min
    let high = max
    const room = (high - low) * pad
    low -= room
    high += room
    // A flat series padded by a fraction of its own extent is still flat.
    if (high - low < span) {
      const grow = (span - (high - low)) / 2
      low -= grow
      high += grow
    }
    if (floor !== undefined) low = Math.max(low, floor)
    if (ceiling !== undefined) high = Math.min(high, ceiling)
    if (high - low < span) {
      high = Math.min(ceiling ?? Infinity, low + span)
      low = Math.max(floor ?? -Infinity, high - span)
    }
    return [low, high]
  }
}
