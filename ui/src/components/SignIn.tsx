import { createSignal, Show } from 'solid-js'

import { signIn, signInRequired } from '../lib/session'

/**
 * The sign-in the dashboard shows when the API answers 401. Deliberately the
 * same surface as the command palette: a small card, a hairline, no ceremony.
 * The password goes straight into a `POST /api/session` and comes back as an
 * `HttpOnly` cookie, so nothing here is ever stored by the app.
 */
export default function SignIn() {
  const [user, setUser] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: Event) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      await signIn(user(), password())
      // Every tile holds a failed query; a reload is the cheapest honest way to
      // ask them all again with the cookie in place.
      window.location.reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  return (
    <Show when={signInRequired()}>
      <div class="signin-backdrop">
        <form class="signin" onSubmit={submit}>
          <p class="signin-title">Sign in</p>
          <input
            type="text"
            name="username"
            placeholder="User"
            autocomplete="username"
            autocapitalize="none"
            spellcheck={false}
            value={user()}
            onInput={(event) => setUser(event.currentTarget.value)}
          />
          <input
            type="password"
            name="password"
            placeholder="Password"
            autocomplete="current-password"
            value={password()}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
          <Show when={error()}>
            <p class="signin-error">{error()}</p>
          </Show>
          <button type="submit" disabled={busy() || !user() || !password()}>
            {busy() ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </Show>
  )
}
