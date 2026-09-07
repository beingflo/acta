# EXAMPLE SPEC: Ingestion

Status: Draft
Owner: flo

## Scope

The HTTP surface that accepts data points pushed by external sources (IoT
sensors, the Overland GPS tracker, auxiliary scrapers, web-service events,
server statistics) and the in-memory buffering that precedes Parquet writes.

Out of scope here: how buffered data is flushed to and compacted in Parquet
files (see `aggregation.md`), and how the frontend reads it back (see
`query.md`).

## Terminology

- **payload** — the JSON body of a single `POST /data` request.
- **source** — a named producer of payloads (e.g. `overland`, `co2-sensor-1`).
- **buffer** — the in-memory set of payloads accepted but not yet written to
  disk.
- **flush** — writing the current buffer contents to a new small Parquet file
  and clearing the buffer.

## Requirements

### REQ-ING-001: Accept arbitrary JSON payloads over HTTP

Status: Draft
Priority: Must

Why: data sources push heterogeneous, evolving schemas (sensor readings, GPS
fixes, scraped pages) and Acta must store them without per-source schema work.
Semi-structured storage via the Parquet Variant type makes this possible, so the
API itself must impose no schema.

Acceptance criteria:

1. `POST /data` accepts any body that is a valid JSON object and responds
   `202 Accepted`, normally within one second.
2. Payload field names, types and nesting are preserved unchanged into the
   buffer and later into storage — no field loss, coercion or reordering.
3. A request without `Content-Type: application/json` is rejected with
   `415 Unsupported Media Type`.
4. A body that is empty, malformed JSON, or valid JSON that is not an object
   (array, string, number, `null`) is rejected with `400 Bad Request` and an
   error body `{"error": "<description>"}`.
5. A payload larger than 1 MiB is rejected with `413 Payload Too Large`
   without being buffered.
6. Rejecting a payload never affects payloads already accepted into the
   buffer.

Scenarios:

1. **Happy path**
   - Given: a valid payload `{"co2": 850, "humidity": 41, "ts": "2025-09-07T12:00:00Z"}`
   - When: a client POSTs it to `/data` with `Content-Type: application/json`
   - Then: the response status is `202 Accepted`
   - And: the payload appears unchanged in the next buffer flush
2. **Wrong content type**
   - Given: a payload POSTed to `/data` with `Content-Type: text/plain`
   - When: the request reaches the server
   - Then: the response status is `415 Unsupported Media Type`
3. **Malformed JSON**
   - Given: a request with `Content-Type: application/json`
   - When: the body is `not json at all`
   - Then: the response status is `400 Bad Request`
   - And: the response body is `{"error": "..."}` with a description
4. **Oversized payload**
   - Given: a payload whose size exceeds 1 MiB
   - When: a client POSTs it to `/data`
   - Then: the response status is `413 Payload Too Large`
   - And: the buffer contents are unchanged

### REQ-ING-002: Buffer with bounded memory and prompt flushing

Status: Draft
Priority: Must

Why: Acta runs on a home server and must "use little to no resources when not
in active use". Buffering trades durability for write efficiency (small Parquet
writes are expensive), so the buffer must be capped and flushed eagerly, never
growing without bound.

Acceptance criteria:

1. The buffer flushes when any of the following first occurs: it holds
   1,000 payloads, its estimated in-memory size exceeds 16 MiB, or 5 seconds
   have passed since the oldest buffered payload was accepted.
2. Flush thresholds are configuration values with the defaults above; memory
   cap and payload-count cap must not exceed their configured values by more
   than one payload.
3. A flush writes the buffer contents to one new Parquet file and clears the
   buffer only after the write has succeeded.
4. If a flush fails (e.g. disk full), buffered payloads are retained and flush
   is retried with backoff; new payloads keep being accepted meanwhile, subject
   to the memory cap.
5. Idle behaviour: with no traffic, the service performs no periodic work —
   no timers fire, CPU stays at zero.
6. The documented durability contract is: a crash (process kill, power loss)
   may lose at most the contents of the current buffer, i.e. at most the last
   5 seconds / 1,000 payloads of accepted data. This contract is stated in the
   API documentation.

Scenarios:

1. **Flush on time**
   - Given: a buffer containing payloads accepted less than 5 seconds ago
   - When: 5 seconds pass since the oldest payload was accepted
   - Then: the buffer contents are written to a new Parquet file
   - And: the buffer is empty
2. **Flush failure retains data**
   - Given: a flush is attempted and fails (e.g. disk full)
   - When: new payloads continue to arrive
   - Then: the payloads remain in the buffer
   - And: flush is retried after a backoff delay
3. **Idle process**
   - Given: a running instance with an empty buffer
   - When: no requests arrive for 10 minutes
   - Then: no writes, timers or CPU activity occur during that period

Notes: ties to the durability goal in `../design/overview.md`; the exact
flush-write mechanics live in the aggregation spec (`aggregation.md`).

### REQ-ING-003: Attribute every payload to a source and timestamp

Status: Draft
Priority: Must

Why: visualisations (histograms, geofence presence) and aggregation all key on
source and time; attribution must therefore be recorded at intake, not
reconstructed later.

Acceptance criteria:

1. Every payload is stored with its **source id**, taken from a
   `source` field in the JSON envelope (see Notes) or from the authenticated
   client identity if no envelope field is present.
2. Every payload is stored with a **received-at** timestamp set by the server
   at acceptance, in UTC.
3. If the payload contains a client-provided `ts` that is a valid timestamp,
   it is stored as the payload's timestamp; otherwise the received-at
   timestamp is used.
4. A client-provided `ts` more than 24 hours in the future or before
   `2000-01-01` causes the payload to be rejected with `400 Bad Request`.
5. Timestamps are stored with microsecond precision and a UTC timezone; no
   local-time conversions occur at intake.

Scenarios:

1. **Client timestamp used**
   - Given: a payload containing `"ts": "2025-09-07T11:59:00Z"`
   - When: it is accepted at 12:00:05Z
   - Then: the stored payload timestamp is `2025-09-07T11:59:00Z`
2. **Missing client timestamp**
   - Given: a payload with no `ts` field
   - When: it is accepted at 12:00:05.123456Z
   - Then: the stored payload timestamp is `12:00:05.123456Z` (received-at)
3. **Future timestamp rejected**
   - Given: a payload containing `"ts": "2030-01-01T00:00:00Z"`
   - When: it is POSTed to `/data`
   - Then: the response status is `400 Bad Request`

Notes: envelope shape is still open — see Open questions. Overland and the
scrapers will need source ids assigned in their deployment config.

### REQ-ING-004: Refuse duplicates at the API boundary

Status: Draft
Priority: Should

Why: clients (especially the Overland iOS tracker and web hooks) retry on
network failures, so the same logical data point can arrive twice. Without a
boundary check, duplicates silently inflate histograms and counts.

Acceptance criteria:

1. A payload is considered a duplicate of an already-accepted payload when its
   (source id, client timestamp) pair matches and its content is identical.
2. Duplicates are answered with `200 OK` (idempotent success) and are **not**
   added to the buffer.
3. The duplicate check covers at least the last 24 hours of accepted payloads.
4. If two identical payloads arrive concurrently, exactly one is buffered.

Scenarios:

1. **Retried request**
   - Given: a payload accepted 10 minutes ago
   - When: the client POSTs the identical payload again
   - Then: the response status is `200 OK`
   - And: the payload is not added to the buffer
2. **Same timestamp, different content**
   - Given: a payload accepted with `"ts": "2025-09-07T12:00:00Z"` and content `{"a": 1}`
   - When: a payload with the same source and `ts` but content `{"a": 2}` is POSTed
   - Then: the response status is `202 Accepted`
   - And: the payload is buffered (it is not a duplicate)

Notes: dedupe state must not grow unbounded — design should pick a compact
representation (see `../design/`); a 24-hour window at typical sensor rates is
small.

## Non-goals

- No authentication/authorization decisions in this spec — the deployment is
  single-user on a home network, but whether `/data` is exposed beyond localhost
  and how it is protected is an operations concern (`OPS`).
- No per-source schema validation, transformation or enrichment at intake.
- No ordering guarantees across flushes: payloads may land in different Parquet
  files than the order in which they were accepted.

## Open questions

1. Envelope shape: is the source id inside the payload (`{"source": "overland", "data": {...}}`),
   a header, or derived from the client? Affects REQ-ING-003 and how scrapers
   are configured. (Preferred: `source` in a small envelope, since headers are
   lost if the home server proxies/relays.)
2. Should `POST /data` also accept a batch (JSON array of payloads) for
   efficiency, and if so how does that interact with the 1 MiB cap and
   duplicate detection in REQ-ING-004?
3. Is a 24-hour dedupe window sufficient for the web hooks and scrapers?
