import { createEffect, createSignal, For, onCleanup, onMount } from 'solid-js'

import { DASHBOARDS } from '../dashboards'

export default function DashboardPicker(props: { active: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal(0)
  let searchRef: HTMLInputElement | undefined

  const filtered = () =>
    DASHBOARDS.filter((dashboard) => dashboard.title.toLowerCase().includes(query().toLowerCase()))

  const openPalette = () => {
    setQuery('')
    setHighlight(0)
    setOpen(true)
  }

  const select = (id: string) => {
    props.onSelect(id)
    setOpen(false)
    setQuery('')
  }

  // Focus the search field whenever the palette opens. `autofocus` is not
  // reliable for elements inserted after page load.
  createEffect(() => {
    if (open()) searchRef?.focus()
  })

  // Reset the highlight to the top of the list whenever the filter changes.
  createEffect(() => {
    query()
    setHighlight(0)
  })

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (open()) setOpen(false)
        else openPalette()
        return
      }
      if (!open()) return

      if (event.key === 'Escape') {
        setOpen(false)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((index) => Math.min(index + 1, filtered().length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((index) => Math.max(index - 1, 0))
      } else if (event.key === 'Enter') {
        const item = filtered()[highlight()]
        if (item) select(item.id)
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      <button class="dashboard-button" onClick={openPalette}>
        {DASHBOARDS.find((dashboard) => dashboard.id === props.active)?.title ?? 'Dashboard'}
      </button>
      {open() && (
        <div class="palette-backdrop" onClick={() => setOpen(false)}>
          <div class="palette" onClick={(event) => event.stopPropagation()}>
            <input
              ref={searchRef}
              placeholder="Go to dashboard…"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <For each={filtered()}>
              {(dashboard, index) => (
                <button
                  classList={{
                    highlighted: index() === highlight(),
                    current: dashboard.id === props.active,
                  }}
                  onMouseEnter={() => setHighlight(index())}
                  onClick={() => select(dashboard.id)}
                >
                  {dashboard.title}
                </button>
              )}
            </For>
          </div>
        </div>
      )}
    </>
  )
}
