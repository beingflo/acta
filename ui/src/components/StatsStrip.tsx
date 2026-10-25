import { For, Show } from 'solid-js'

/** One card in the strip: a label, a value with its unit, and an optional
 *  second line with the context that would not fit the value. */
export type Stat = {
  label: string
  value: string
  unit?: string
  detail?: string
  /** Full text on hover, for what the card itself cannot show. */
  title?: string
}

/**
 * A row of scalars above a dashboard's tiles, in the summary strip's clothes.
 * Presentational: the dashboard decides what is worth counting and how to
 * format it.
 */
export default function StatsStrip(props: { stats: Stat[] }) {
  return (
    <div class="latest-strip">
      <For each={props.stats}>
        {(stat) => (
          <div class="latest-card" title={stat.title}>
            <div class="latest-card-title">{stat.label}</div>
            <div class="latest-card-value">
              {stat.value}
              <Show when={stat.unit}>
                <span class="latest-card-unit">{stat.unit}</span>
              </Show>
            </div>
            <Show when={stat.detail}>
              <div class="latest-card-sub">{stat.detail}</div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
