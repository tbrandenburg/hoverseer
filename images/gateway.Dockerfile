FROM node:24-bookworm-slim
COPY --chown=node:node gateway/server.mjs gateway/openapi.json /gateway/
USER node
CMD ["node", "/gateway/server.mjs"]
