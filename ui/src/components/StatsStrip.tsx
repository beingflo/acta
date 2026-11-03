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
  /** Paint the card as a problem rather than a reading, for a value that is
   *  only shown because it must not be missed. */
  alert?: boolean
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
          <div
            class="latest-card"
            classList={{ 'latest-card-alert': stat.alert }}
            title={stat.title}
          >
            <div class="latest-card-title">{stat.label}</div>
            <div class="latest-card-value">
              {stat.value}
              <Show when={stat.unit}>
                <span class="latest-card-unit">{stat.unit}</span>
              </Show>
            </div>
            {/* Drawn even when the stat has no detail: the values hug the bottom
                of their card, so a card that skipped this line would place its
                number one line lower than the rest of the row. */}
            <div class="latest-card-sub">{stat.detail ?? ''}</div>
          </div>
        )}
      </For>
    </div>
  )
}
