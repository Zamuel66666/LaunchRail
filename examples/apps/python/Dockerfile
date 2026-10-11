FROM python:3.12-slim@sha256:090ba77e2958f6af52a5341f788b50b032dd4ca28377d2893dcf1ecbdfdfe203
WORKDIR /app
COPY server.py ./server.py
USER 65532:65532
EXPOSE 3000
CMD ["python", "-u", "server.py"]
