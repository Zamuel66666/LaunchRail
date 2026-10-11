FROM node:22.23.2-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
WORKDIR /app
COPY examples/apps/node/server.mjs ./server.mjs
USER 65532:65532
EXPOSE 3000
CMD ["node", "server.mjs"]
