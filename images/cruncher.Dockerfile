FROM node:24-bookworm-slim
WORKDIR /app/cruncher
COPY cruncher/package.json cruncher/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY cruncher/main.mjs cruncher/activities.mjs ./
COPY gateway/hitly.mjs /app/gateway/hitly.mjs
USER node
CMD ["node", "main.mjs"]
