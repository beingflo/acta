import { requireSignIn, Unauthorized } from './session'

/** A row as the service returns it: a bucket stamp and one column per series. */
type Row = Record<string, number | string>

/**
 * `POST` and decode, with the one behaviour every call shares: a 401 raises the
 * sign-in form instead of letting each tile log the same failed query.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 401) {
    requireSignIn()
    throw new Unauthorized()
  }
  if (!response.ok) {
    let message = response.statusText
    try {
      const payload = (await response.json()) as { error?: string }
      message = payload.error ?? message
    } catch {
      // body was not JSON, keep the status text
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

/** One page of rows from a free-form query. The owner's credential only. */
export function fetchData<T>(sql: string): Promise<T> {
  return post<T>('/api/data', { sql })
}

/** One named reading a chart may draw (`service/src/metrics.rs`). */
export type SeriesMetric = {
  /** The service's metric id. */
  metric: string
  /** The line's name in the tooltip. */
  label: string
}

/**
 * The named readings, bucketed together. This is what a restricted viewer's
 * dashboard asks for: the service owns the SQL, so the request names metrics
 * and nothing else. Several readings are joined on the bucket, which is how one
 * chart draws two sensors.
 */
export function fetchSeries<T>(
  metrics: string[],
  bucketMs: number,
  from: Date,
  to: Date,
): Promise<T> {
  return post<T>('/api/series', {
    metrics,
    bucket_ms: bucketMs,
    from: from.toISOString(),
    to: to.toISOString(),
  })
}

export type { Row }
