import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { DASHBOARDS } from '../dashboards'

export default function DashboardPicker(props: { active: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal(0)
  let searchRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const filtered = () =>
    DASHBOARDS.filter((dashboard) => dashboard.title.toLowerCase().includes(query().toLowerCase()))

  const openPalette = () => {
    setQuery('')
    // Start on the current dashboard rather than the top of the list.
    const index = DASHBOARDS.findIndex((dashboard) => dashboard.id === props.active)
    setHighlight(index >= 0 ? index : 0)
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

  // Keep the highlighted row in view, for a list longer than the panel.
  createEffect(() => {
    const index = highlight()
    if (!open()) return
    listRef?.querySelectorAll('button')[index]?.scrollIntoView({ block: 'nearest' })
  })

  onMount(() => {
    const move = (delta: number) =>
      setHighlight((index) =>
        Math.min(Math.max(index + delta, 0), Math.max(filtered().length - 1, 0)),
      )

    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const ctrl = event.ctrlKey
      const meta = event.metaKey

      if (!open()) {
        if ((meta || ctrl) && key === 'k') {
          event.preventDefault()
          openPalette()
        }
        return
      }

      if (event.key === 'Escape') {
        setOpen(false)
      } else if (event.key === 'ArrowDown' || (ctrl && key === 'j')) {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowUp' || (ctrl && key === 'k')) {
        event.preventDefault()
        move(-1)
      } else if (meta && key === 'k') {
        // On macOS keep cmd+k as close; ctrl+k is navigation above.
        event.preventDefault()
        setOpen(false)
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
          <div
            class="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Go to dashboard"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="palette-search">
              <input
                ref={searchRef}
                placeholder="Go to dashboard…"
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value)
                  // Typing narrows the list; put the highlight on the first match.
                  setHighlight(0)
                }}
              />
              <kbd>esc</kbd>
            </div>
            <div class="palette-list" ref={listRef}>
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
                    <Show when={dashboard.id === props.active}>
                      <span class="palette-tag">current</span>
                    </Show>
                  </button>
                )}
              </For>
              <Show when={filtered().length === 0}>
                <p class="palette-empty">Nothing matches “{query()}”.</p>
              </Show>
            </div>
            <div class="palette-hints">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> open
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
