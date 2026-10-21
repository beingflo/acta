# --- frontend ---------------------------------------------------------------
FROM node:23-bookworm AS ui-builder
WORKDIR /usr/src/acta/ui

COPY ui/package.json ui/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/usr/src/acta/ui/node_modules \
    npm ci

COPY ./ui/ ./
RUN --mount=type=cache,target=/usr/src/acta/ui/node_modules \
    npm run build

# --- backend ----------------------------------------------------------------
# `duckdb` is built from its bundled amalgamation with g++ (no cmake/python).
# The first build compiles it and is slow; afterwards the target cache keeps
# dependency rebuilds to the `acta` crate itself.
FROM rust:bookworm AS builder
WORKDIR /usr/src/acta/service

COPY service/Cargo.toml service/Cargo.lock ./
# Prime the dependency cache with a throwaway binary, so a source-only change
# does not invalidate the dependency layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/usr/src/acta/service/target \
    mkdir -p src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

COPY service/src ./src
# The `touch` is load-bearing. COPY keeps the build context's mtimes, which are
# older than the fingerprints the priming build above recorded, so cargo treats
# the package as fresh, skips the rebuild, and /tmp/acta stays the throwaway
# binary from that layer — a container that exits 0 before logging anything.
# The size check fails the build loudly if that ever happens again.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/usr/src/acta/service/target \
    find src -exec touch {} + \
    && cargo build --release \
    && cp target/release/acta /tmp/acta \
    && test "$(stat -c %s /tmp/acta)" -gt 1000000

# --- runtime ----------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY --from=builder /tmp/acta /usr/local/bin/acta
COPY --from=ui-builder /usr/src/acta/ui/dist ./ui/dist
RUN mkdir -p tiles

ENV ACTA_ADDR=0.0.0.0:8080 \
    ACTA_DATA_DIR=/data \
    ACTA_UI_DIR=/usr/src/app/ui/dist \
    ACTA_TILES_DIR=/usr/src/app/tiles

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/acta"]
