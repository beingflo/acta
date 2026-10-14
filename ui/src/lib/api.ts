export async function fetchData<T>(sql: string): Promise<T> {
  const response = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: string }
      message = body.error ?? message
    } catch {
      // body was not JSON, keep the status text
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}
