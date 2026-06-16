# openabc gateway — native avatar UI + openab.gateway WS bridge.
#
# Packaged into the openab-host dev fleet as the compose service `gateway`,
# published on 127.0.0.1:8137 so bot containers reach it via
# host.docker.internal:8137 (the host-side localhost-only bridge).
#
# The binary embeds frontend/dist via include_bytes! at compile time. The
# committed dist (guarded by frontend/verify-dist.sh) is the source of truth,
# so there is no frontend build step here.

FROM rust:1-slim-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/openabc /usr/local/bin/openabc
# Bind all interfaces *inside* the container; the compose port mapping
# (127.0.0.1:8137:8137) is what keeps it a localhost-only bridge on the host.
ENV OPENABC_LISTEN=0.0.0.0:8137
EXPOSE 8137
ENTRYPOINT ["openabc"]
