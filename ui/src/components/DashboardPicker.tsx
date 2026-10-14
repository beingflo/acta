import { createSignal, For, onCleanup, onMount } from 'solid-js'

import { DASHBOARDS } from '../dashboards'

export default function DashboardPicker(props: { active: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')

  const filtered = () =>
    DASHBOARDS.filter((dashboard) => dashboard.title.toLowerCase().includes(query().toLowerCase()))

  const select = (id: string) => {
    props.onSelect(id)
    setOpen(false)
    setQuery('')
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      } else if (event.key === 'Escape') {
        setOpen(false)
      } else if (event.key === 'Enter' && open()) {
        const first = filtered()[0]
        if (first) select(first.id)
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      <button class="dashboard-button" onClick={() => setOpen(true)}>
        {DASHBOARDS.find((dashboard) => dashboard.id === props.active)?.title ?? 'Dashboard'}
        <kbd>⌘K</kbd>
      </button>
      {open() && (
        <div class="palette-backdrop" onClick={() => setOpen(false)}>
          <div class="palette" onClick={(event) => event.stopPropagation()}>
            <input
              autofocus
              placeholder="Go to dashboard…"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <For each={filtered()}>
              {(dashboard) => (
                <button
                  classList={{ active: dashboard.id === props.active }}
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
