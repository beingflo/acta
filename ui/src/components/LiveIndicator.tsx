import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'

import { isLiveWindow, refreshTick } from '../lib/refresh'

/** How long the mark stays up to acknowledge an `r` press. */
const FLASH_MS = 480
const FLASH_ANIMATION_MS = 400

/**
 * Marks a live window: while it is selected, every tile polls every ten
 * seconds. A dot and one word next to the range buttons say so without taking a
 * control of their own. Pressing `r` flashes the same mark — even on a
 * historical window, where the mark is otherwise absent — so the key press is
 * visible without changing the range.
 */
export default function LiveIndicator() {
  const [live, setLive] = createSignal(isLiveWindow())
  const [flashing, setFlashing] = createSignal(false)

  let mark: HTMLSpanElement | undefined
  let animation: Animation | undefined
  let flashTimer = 0

  const flash = () => {
    setFlashing(true)
    window.clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => setFlashing(false), FLASH_MS)
    // The element exists only after the update above renders.
    requestAnimationFrame(() => {
      if (!mark) return
      animation?.cancel()
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      animation = mark.animate(
        [
          { opacity: 0.2, transform: 'scale(0.9)' },
          { opacity: 1, transform: 'scale(1.06)', offset: 0.5 },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: FLASH_ANIMATION_MS, easing: 'ease-out' },
      )
    })
  }

  // A selection change flips the mark immediately ...
  createEffect(() => setLive(isLiveWindow()))
  // ... the clock can flip it off (a custom window stops ending "now") ...
  onMount(() => {
    const timer = window.setInterval(() => setLive(isLiveWindow()), 10_000)
    onCleanup(() => {
      clearInterval(timer)
      clearTimeout(flashTimer)
      animation?.cancel()
    })
  })
  // ... and `r` acknowledges itself.
  createEffect(on(refreshTick, flash, { defer: true }))

  return (
    <Show when={live() || flashing()}>
      <span
        ref={mark}
        class="live-indicator"
        role="status"
        aria-label="Live: auto-refreshing every 10 seconds"
        title="Live: auto-refreshing every 10 s"
      >
        <span class="live-dot" aria-hidden="true" />
        live
      </span>
    </Show>
  )
}
