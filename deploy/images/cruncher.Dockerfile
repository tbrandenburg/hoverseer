FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /var/lib/hoverseer/workspaces
ENV HOVERSEER_WORKSPACES_DIR=/var/lib/hoverseer/workspaces
WORKDIR /app/cruncher
COPY cruncher/package.json cruncher/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY cruncher/main.mjs cruncher/infisical.mjs cruncher/activity-runtime.mjs ./
COPY nodes/ /app/nodes/
COPY integrations/hitly/client.mjs /app/integrations/hitly/
USER node
CMD ["node", "main.mjs"]
