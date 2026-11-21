FROM node:24-bookworm-slim
WORKDIR /app/cruncher
COPY cruncher/package.json cruncher/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY cruncher/main.mjs cruncher/infisical.mjs ./
COPY cruncher/steps/ ./steps/
COPY integrations/hitly/client.mjs /app/integrations/hitly/
USER node
CMD ["node", "main.mjs"]
