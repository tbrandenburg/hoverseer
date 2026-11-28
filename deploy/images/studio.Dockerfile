FROM ghcr.io/zigflow/zigflow:0.18.1 AS zigflow
FROM node:24-bookworm-slim AS build
ARG STUDIO_REF=125ef643bcf92948dc0acc94c9ca9dfa11c4847b
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl patch && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=zigflow /app/app /usr/local/bin/zigflow
RUN curl -fsSL --retry 3 -o /tmp/studio.tar.gz "https://codeload.github.com/zigflow/studio/tar.gz/${STUDIO_REF}" \
    && tar -xzf /tmp/studio.tar.gz --strip-components=1 \
    && rm /tmp/studio.tar.gz \
    && npm ci
COPY nodes/ ./hoverseer-nodes/
COPY deploy/studio/ActivityNodeForm.svelte deploy/studio/nodes.ts ./src/lib/hoverseer/
COPY deploy/studio/hoverseer-nodes.patch /tmp/hoverseer-nodes.patch
RUN mv src/hooks.server.ts src/hooks.upstream.server.ts
COPY deploy/studio/workspace-hooks.server.ts ./src/hooks.server.ts
RUN patch --batch --fuzz=0 -p1 < /tmp/hoverseer-nodes.patch \
    && npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=zigflow /app/app /usr/local/bin/zigflow
COPY --from=build /app/build /app/build
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production ZIGFLOW_STORAGE_DIR=/workflows ORIGIN=http://localhost:3000
USER node
EXPOSE 3000
CMD ["node", "build"]
