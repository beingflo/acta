# API tests

Crude [hurl](https://hurl.dev) scenarios for the service API. They expect a
running service with `data/*.parquet` present.

```
mise run test
```

Override the target with `ACTA_URL`:

```
ACTA_URL=http://host:8080 mise run test
```

These read a fixed historical window (`2026-10-10`) so the expected point counts
are stable. If the migrated data changes, update the counts.
