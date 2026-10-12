FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
WORKDIR /app
COPY examples/apps/python/server.py ./server.py
USER 65532:65532
EXPOSE 3000
CMD ["python", "-u", "server.py"]
