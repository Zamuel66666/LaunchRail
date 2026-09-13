import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkHttpHealth } from "../src/index.js";

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
  it("rejects unsafe paths", async () => {
    await expect(
      checkHttpHealth({ host: "127.0.0.1", port, path: "//other", timeoutMs: 1000 }),
    ).rejects.toThrow(RangeError);
  });
});
