import { For } from 'solid-js'

import { PRESETS, preset, range, setCustomRange, setPreset } from '../lib/range'

export default function RangePicker() {
  // The custom inputs are shown whenever the custom preset is active, whether it
  // was selected with the `C` button or by brushing a chart.
  const isCustom = () => preset() === 'custom'

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
          <input
            type="datetime-local"
            value={toInputValue(range().from)}
            onChange={(e) => applyCustom(e.currentTarget.value, toInputValue(range().to))}
          />
          <span>→</span>
          <input
            type="datetime-local"
            value={toInputValue(range().to)}
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
