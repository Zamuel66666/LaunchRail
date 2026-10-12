import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const instances: {
  pool: EventEmitter;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  config: Record<string, unknown>;
}[] = [];
vi.mock("pg", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    Pool: class extends Emitter {
      query = vi.fn().mockResolvedValue({ rows: [] });
      end = vi.fn().mockResolvedValue(undefined);
      constructor(config: Record<string, unknown>) {
        super();
        instances.push({ pool: this, query: this.query, end: this.end, config });
      }
    },
  };
});

import { createDatabaseClient } from "../src/client.js";

beforeEach(() => {
  instances.length = 0;
});
describe("PostgreSQL connection-pool interruption", () => {
  it("handles idle errors without process failure, fences readiness, and reconnects on later checks", async () => {
    const event = vi.fn();
    const client = createDatabaseClient("postgresql://fixture:fixture@localhost/test", {
      onInfrastructureEvent: event,
    });
    const instance = instances[0]!;
    expect(instance.config).toMatchObject({ connectionTimeoutMillis: 2000, query_timeout: 2000 });
    expect(() => instance.pool.emit("error", new Error("PRIVATE_DATABASE_CANARY"))).not.toThrow();
    expect(event).toHaveBeenCalledExactlyOnceWith({
      code: "idle_connection_error",
      component: "connection_pool",
    });
    expect(JSON.stringify(event.mock.calls)).not.toContain("PRIVATE_DATABASE_CANARY");
    instance.query.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_CANARY"));
    expect(await client.checkReady()).toBe(false);
    expect(await client.checkReady()).toBe(true);
    await client.close();
    expect(instance.end).toHaveBeenCalledOnce();
  });
  it("handles errors without a diagnostics callback and when diagnostics throw", async () => {
    const first = createDatabaseClient({
      connectionString: "postgresql://fixture:fixture@localhost/test",
    });
    expect(() =>
      instances[0]!.pool.emit("error", new Error("PRIVATE_DATABASE_CANARY")),
    ).not.toThrow();
    const second = createDatabaseClient("postgresql://fixture:fixture@localhost/test", {
      onInfrastructureEvent: () => {
        throw new Error("PRIVATE_DIAGNOSTICS_CANARY");
      },
    });
    expect(() =>
      instances[1]!.pool.emit("error", new Error("PRIVATE_DATABASE_CANARY")),
    ).not.toThrow();
    await first.close();
    await second.close();
  });
});
