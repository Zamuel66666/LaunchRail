FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY examples/apps/node/server.mjs ./server.mjs
USER 65532:65532
EXPOSE 3000
CMD ["node", "server.mjs"]
