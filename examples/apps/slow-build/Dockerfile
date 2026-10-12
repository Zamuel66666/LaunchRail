FROM busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23
# Deliberately observable, cold-cache boundary for worker interruption acceptance.
RUN sleep 10
COPY examples/apps/healthy/index.html /site/index.html
USER 65532:65532
EXPOSE 3000
CMD ["httpd", "-f", "-p", "3000", "-h", "/site"]
