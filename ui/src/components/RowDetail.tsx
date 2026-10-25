import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js'

import { closeDetail, detail } from '../lib/detail'

/** Two columns: a wide event is read as a shape, not as one long line. */
function pretty(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  // `undefined` (a bare `null` result, say) has no JSON form at all.
  return text ?? String(value)
}

/** One piece of the pretty-printed document, coloured by what it is. */
type Token = {
  text: string
  /** Empty for whitespace and punctuation, which are left in the body colour. */
  kind: '' | 'key' | 'string' | 'number' | 'literal'
}

/**
 * Rudimentary JSON colouring, over the text `JSON.stringify` just produced.
 *
 * A key is a string followed by a colon; every other string is a value. That
 * one distinction is most of the readability, and it needs no parser: the input
 * is machine-generated JSON, so the token order is already canonical.
 */
function tokenize(json: string): Token[] {
  const pattern = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g
  const tokens: Token[] = []
  let at = 0

  for (const match of json.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > at) tokens.push({ text: json.slice(at, start), kind: '' })
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], kind: match[2] ? 'key' : 'string' })
      if (match[2]) tokens.push({ text: match[2], kind: '' })
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], kind: 'number' })
    } else {
      tokens.push({ text: match[4], kind: 'literal' })
    }
    at = start + match[0].length
  }
  if (at < json.length) tokens.push({ text: json.slice(at), kind: '' })
  return tokens
}

/**
 * One event, whole. The panel is wide and scrolls vertically inside itself, and
 * the JSON wraps rather than scrolling sideways: one user agent is wider than
 * any panel, and a horizontal scrollbar on a phone is a dead end.
 */
export default function RowDetail() {
  const [copied, setCopied] = createSignal(false)
  let timer = 0
  let body: HTMLPreElement | undefined

  const text = createMemo(() => pretty(detail()?.value))
  const tokens = createMemo(() => tokenize(text()))

  // A new event starts at its first line, not wherever the previous one was
  // scrolled to.
  createEffect(
    on(
      detail,
      () => {
        if (body) body.scrollTop = 0
      },
      { defer: true },
    ),
  )

  const copy = () => {
    navigator.clipboard
      ?.writeText(text())
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer)
        timer = window.setTimeout(() => setCopied(false), 1400)
      })
      .catch((error) => console.error('could not copy the event', error))
  }

  // Clicking the hush closes; clicking the panel itself must not.
  return (
    <Show when={detail()}>
      {(current) => (
        <div class="detail-backdrop" onClick={closeDetail}>
          <div
            class="detail"
            role="dialog"
            aria-label="Event detail"
            onClick={(event) => event.stopPropagation()}
          >
            <header class="detail-head">
              <span class="detail-title">{current().title}</span>
              <span class="detail-time">{current().subtitle}</span>
              <span class="spacer" />
              <Show when={current().step}>
                <span class="detail-hint">↑↓ walks the table</span>
              </Show>
              <button class="detail-button" onClick={copy}>
                {copied() ? 'copied' : 'copy'}
              </button>
              <button class="detail-button" onClick={closeDetail} aria-label="Close">
                ×
              </button>
            </header>
            <pre class="detail-json" ref={body}>
              <For each={tokens()}>
                {(token) => (
                  <span class={token.kind === '' ? undefined : `json-${token.kind}`}>
                    {token.text}
                  </span>
                )}
              </For>
            </pre>
          </div>
        </div>
      )}
    </Show>
  )
}
