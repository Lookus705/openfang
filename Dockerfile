# syntax=docker/dockerfile:1
FROM rust:1-slim-bookworm AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y pkg-config libssl-dev perl make && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY xtask ./xtask
COPY agents ./agents
COPY packages ./packages
# Optional build args for dev environments to speed up compilation
# Example: docker build --build-arg LTO=false --build-arg CODEGEN_UNITS=16 .
ARG LTO=true
ARG CODEGEN_UNITS=1
ENV CARGO_PROFILE_RELEASE_LTO=${LTO} \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=${CODEGEN_UNITS}
RUN cargo build --release --bin openfang

FROM rust:1-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/openfang /usr/local/bin/
COPY --from=builder /build/agents /opt/openfang/agents
COPY packages/supabase-mcp/package.json packages/supabase-mcp/package-lock.json /opt/openfang/supabase-mcp/
RUN npm ci --omit=dev --prefix /opt/openfang/supabase-mcp
COPY packages/supabase-mcp/index.mjs /opt/openfang/supabase-mcp/index.mjs
COPY packages/driver-ops-mcp/package.json packages/driver-ops-mcp/package-lock.json /opt/openfang/driver-ops-mcp/
RUN npm ci --omit=dev --prefix /opt/openfang/driver-ops-mcp
COPY packages/driver-ops-mcp/index.mjs /opt/openfang/driver-ops-mcp/index.mjs
EXPOSE 4200
VOLUME /data
ENV OPENFANG_HOME=/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD python3 -c "import sys,urllib.request; resp=urllib.request.urlopen('http://127.0.0.1:4200/api/health', timeout=3); sys.exit(0 if resp.status == 200 else 1)"
ENTRYPOINT ["openfang"]
CMD ["start"]
