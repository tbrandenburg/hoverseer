FROM node:24-bookworm-slim
ARG HITLY_REF=91c784e6e0e645618b1a16a5375a5433ed131ec0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bash && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN curl -fsSL --retry 3 -o /tmp/hitly.tar.gz "https://codeload.github.com/hitly-net/hitly/tar.gz/${HITLY_REF}" \
    && tar -xzf /tmp/hitly.tar.gz --strip-components=1 \
    && rm /tmp/hitly.tar.gz \
    && rm -rf apps/mobile apps/web apps/mcp examples \
    && npm install --global --force yarn@1.22.22 \
    && yarn install --frozen-lockfile --non-interactive
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3001
# The upstream dev server is sufficient for a local PoC.
CMD ["bash", "-c", "yarn db:migrate && exec yarn workspace @hitly/app dev --hostname 0.0.0.0"]
