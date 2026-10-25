import { createSignal } from 'solid-js'

/**
 * The dashboard's own sign-in.
 *
 * API calls carry whatever credential the browser kept; when there is none the
 * service answers 401, and the app asks for the password itself rather than
 * letting the browser prompt. That prompt is the reason this exists: iOS never
 * saves basic credentials, and an installed home-screen app gets its own storage
 * container, so a PWA relying on it asks for the password on every cold launch.
 *
 * What the browser keeps instead is an `HttpOnly` session cookie — invisible to
 * this code, two months long, and handed out by `POST /api/session`.
 */

/** True once an API call has been refused for want of a session. */
const [signInRequired, setSignInRequired] = createSignal(false)

/** What this credential may read: the owner's everything, or the home readings. */
const [scope, setScope] = createSignal<'all' | 'home'>('all')

export { scope, signInRequired }

/**
 * Ask the service what this credential may read, so the picker offers only the
 * dashboards it can fill. The restriction itself lives on the server — this is
 * presentation, and a wrong answer here cannot widen anything.
 */
export async function loadScope(): Promise<void> {
  const response = await fetch('/api/me')
  if (response.status === 401) {
    requireSignIn()
    return
  }
  if (!response.ok) return
  const body = (await response.json()) as { scope?: string }
  setScope(body.scope === 'home' ? 'home' : 'all')
}

/** A 401: no cookie, or one past its two months. */
export class Unauthorized extends Error {
  constructor() {
    super('sign in to continue')
  }
}

export function requireSignIn() {
  setSignInRequired(true)
}

/**
 * Trade credentials for the cookie. `Authorization` is set here rather than left
 * to the browser, so no native dialog ever appears; the server answers with the
 * cookie and the browser stores it for the origin — inside the PWA, that is the
 * app's own container, which survives relaunches.
 */
export async function signIn(user: string, password: string): Promise<void> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { Authorization: basic(user, password) },
  })
  if (response.ok) {
    setSignInRequired(false)
    await loadScope()
    return
  }
  if (response.status === 429) {
    // The service paces failed sign-ins; it says for how long.
    const seconds = Number(response.headers.get('Retry-After') ?? '60')
    throw new Error(`Too many attempts. Try again in ${seconds}s.`)
  }
  throw new Error(
    response.status === 401 ? 'That user and password do not match.' : response.statusText,
  )
}

/** Forget the cookie, and ask for credentials again. */
export async function signOut(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' })
  setSignInRequired(true)
}

/** `Basic …` with the UTF-8 the service advertises, not `btoa`'s Latin-1. */
function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}
