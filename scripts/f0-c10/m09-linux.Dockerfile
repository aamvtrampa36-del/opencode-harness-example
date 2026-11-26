FROM docker.io/library/node:24.20.0-trixie@sha256:499ac30d42645e5c2227c0f8ff2439499da08b8893326a991f192dfe8e6b1d98
COPY --chmod=0755 bun /usr/local/bin/bun
