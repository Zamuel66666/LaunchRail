import { expect, it, vi } from "vitest";
import { controlDeployment } from "./api";

it("uses a fresh rollback command key for each confirmed action so failed preparation can be retried", async () => {
  const fetchMock = vi.fn(
    async (_url: string, _options: RequestInit) => new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    await controlDeployment("organization", "deployment", "rollback");
    await controlDeployment("organization", "deployment", "rollback");
    const keys = fetchMock.mock.calls.map(([, options]) =>
      new Headers(options.headers).get("idempotency-key"),
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).not.toBe(keys[0]);
    expect(fetchMock.mock.calls[0]?.[1].credentials).toBe("include");
  } finally {
    vi.unstubAllGlobals();
  }
});
