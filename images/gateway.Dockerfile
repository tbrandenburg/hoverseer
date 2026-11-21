FROM node:24-bookworm-slim
COPY --chown=node:node gateway/server.mjs /gateway/server.mjs
USER node
CMD ["node", "/gateway/server.mjs"]
