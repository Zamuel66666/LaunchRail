import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkHttpHealth, type HttpHealthCheckError } from "../src/index.js";

describe("checkHttpHealth", () => {
  const server = createServer((_request, response) => response.writeHead(204).end());
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(
    async () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  it("returns status and bounded duration", async () => {
    await expect(
      checkHttpHealth({ host: "127.0.0.1", port, path: "/health", timeoutMs: 1000 }),
    ).resolves.toMatchObject({ statusCode: 204 });
  });
  it("allows a newly started runtime to begin listening within the existing health window", async () => {
    const delayed = createServer((_request, response) => response.writeHead(200).end("ready"));
    await new Promise<void>((resolve) => delayed.listen(0, "127.0.0.1", resolve));
    const delayedPort = (delayed.address() as { port: number }).port;
    await new Promise<void>((resolve) => delayed.close(() => resolve()));
    const timer = setTimeout(() => delayed.listen(delayedPort, "127.0.0.1"), 60);
    try {
      const result = await checkHttpHealth({
        host: "127.0.0.1",
        port: delayedPort,
        path: "/",
        timeoutMs: 1000,
      });
      expect(result.statusCode).toBe(200);
      expect(result.durationMs).toBeGreaterThanOrEqual(60);
      expect(result.durationMs).toBeLessThan(1000);
    } finally {
      clearTimeout(timer);
      await new Promise<void>((resolve) => delayed.close(() => resolve()));
    }
  });
  it("settles with a typed error when a response body is aborted", async () => {
    const broken = createServer((_request, response) => {
      response.writeHead(200, { "content-length": "10" });
      response.write("x");
      setTimeout(() => response.destroy(), 10);
    });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const brokenPort = (broken.address() as { port: number }).port;
    try {
      await expect(
        checkHttpHealth({ host: "127.0.0.1", port: brokenPort, path: "/", timeoutMs: 500 }),
      ).rejects.toMatchObject({ code: "health_invalid_response" });
    } finally {
      await new Promise<void>((resolve) => broken.close(() => resolve()));
    }
  });
  it("rejects unsafe paths", async () => {
    await expect(
      checkHttpHealth({ host: "127.0.0.1", port, path: "//other", timeoutMs: 1000 }),
    ).rejects.toThrow(RangeError);
  });
  it("rejects non-loopback targets", async () => {
    await expect(
      checkHttpHealth({ host: "example.com", port, path: "/health", timeoutMs: 1000 }),
    ).rejects.toThrow(RangeError);
  });
  it("returns a bounded typed failure when the application exceeds the timeout", async () => {
    const slowServer = createServer((_request, response) => {
      setTimeout(() => response.writeHead(204).end(), 100);
    });
    await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
    const slowPort = (slowServer.address() as { port: number }).port;

    await expect(
      checkHttpHealth({ host: "127.0.0.1", port: slowPort, path: "/health", timeoutMs: 15 }),
    ).rejects.toMatchObject({
      code: "health_timeout",
      durationMs: expect.any(Number),
    } satisfies Partial<HttpHealthCheckError>);

    await new Promise<void>((resolve, reject) =>
      slowServer.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
