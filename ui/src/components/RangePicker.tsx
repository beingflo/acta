import { createEffect, createSignal, For, on, onCleanup, onMount } from 'solid-js'

import { formatSpan } from '../lib/format'
import { PRESETS, preset, range, setCustomRange, setPreset } from '../lib/range'
import { refreshTick } from '../lib/refresh'

export default function RangePicker() {
  // The custom inputs are shown whenever the custom preset is active, whether it
  // was selected with the `C` button or by brushing a chart.
  const isCustom = () => preset() === 'custom'

  // The end of a live range is "now", so the field showing it has to advance
  // with the clock too: at once on `r`, otherwise every ten seconds while the
  // panel is open. A focused field is left alone so typing is never overwritten.
  const [clock, setClock] = createSignal(0)
  const bump = () => setClock((n) => n + 1)
  let toInput!: HTMLInputElement

  createEffect(on(refreshTick, bump, { defer: true }))
  onMount(() => {
    const timer = window.setInterval(() => {
      if (isCustom() && document.activeElement !== toInput) bump()
    }, 10_000)
    onCleanup(() => clearInterval(timer))
  })

  const toValue = () => {
    clock() // track the clock as well as the selection
    return toInputValue(range().to)
  }

  const applyCustom = (from: string, to: string) => {
    const start = new Date(from)
    const end = new Date(to)
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
      setCustomRange({ from: start, to: end })
    }
  }

  return (
    <div class="range-picker">
      <div class="presets">
        <For each={PRESETS}>
          {(item) => (
            <button
              classList={{ active: preset() === item.id }}
              onClick={() => setPreset(item.id)}
            >
              {item.label}
            </button>
          )}
        </For>
        <button
          classList={{ active: isCustom() }}
          onClick={() => {
            if (isCustom()) setPreset('1d')
            else setCustomRange(range())
          }}
        >
          C
        </button>
      </div>
      {isCustom() && (
        <div class="custom-range">
          {/* How much of the record the two fields below add up to: brushing a
              chart picks a window by eye, and a span is what the eye lacks. */}
          <span class="custom-span" title="Approximate length of the selected range">
            ~{formatSpan(range().to.getTime() - range().from.getTime())}
          </span>
          <input
            type="datetime-local"
            value={toInputValue(range().from)}
            onChange={(e) => applyCustom(e.currentTarget.value, toInputValue(range().to))}
          />
          <span>→</span>
          <input
            ref={toInput}
            type="datetime-local"
            value={toValue()}
            onChange={(e) => applyCustom(toInputValue(range().from), e.currentTarget.value)}
          />
        </div>
      )}
    </div>
  )
}

function toInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('')
}
