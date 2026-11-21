FROM node:24-bookworm-slim
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY api/a2a.mjs api/auth.mjs api/catalog.mjs api/main.mjs api/mcp.mjs api/runs.mjs api/server.mjs ./
USER node
CMD ["node", "main.mjs"]
