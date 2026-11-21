FROM node:24-bookworm-slim
COPY --chown=node:node gateway/server.mjs gateway/openapi.json /app/gateway/
COPY --chown=node:node integrations/hitly/client.mjs /app/integrations/hitly/
USER node
CMD ["node", "/app/gateway/server.mjs"]
