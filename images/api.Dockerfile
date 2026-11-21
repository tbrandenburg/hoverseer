FROM node:24-bookworm-slim
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY api/catalog.mjs api/server.mjs api/main.mjs ./
USER node
CMD ["node", "main.mjs"]
