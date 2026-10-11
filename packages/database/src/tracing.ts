import { withTraceSpan } from "@launchrail/observability";

/** Wrap an application-owned persistence adapter in low-cardinality store-method spans. */
export function traceDatabaseStore<T extends object>(store: T, name: string): T {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(name))
    throw new RangeError("Database store trace name is invalid");

  const wrappers = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || property === "constructor" || typeof value !== "function")
        return value;
      const existing = wrappers.get(property);
      if (existing !== undefined) return existing;
      const wrapper = (...args: unknown[]): Promise<unknown> =>
        withTraceSpan(
          `launchrail.database.${name}.${property}`,
          { "db.system.name": "postgresql", "launchrail.database.store": name },
          async () => await Reflect.apply(value, target, args),
        );
      wrappers.set(property, wrapper);
      return wrapper;
    },
  }) as T;
}
