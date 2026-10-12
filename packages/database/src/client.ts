import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type LaunchRailDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: LaunchRailDatabase;
  checkReady(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DatabaseInfrastructureEvent {
  readonly code: "idle_connection_error";
  readonly component: "connection_pool";
}

export function createDatabaseClient(
  config: PoolConfig | string,
  options: { readonly onInfrastructureEvent?: (event: DatabaseInfrastructureEvent) => void } = {},
): DatabaseClient {
  const pool = new Pool(
    typeof config === "string"
      ? { connectionString: config, query_timeout: 2_000, connectionTimeoutMillis: 2_000 }
      : { query_timeout: 2_000, connectionTimeoutMillis: 2_000, ...config },
  );
  pool.on("error", () => {
    // pg-pool removes an interrupted idle connection. Without a listener its
    // error event crashes the process; subsequent queries must instead reconnect
    // or fail under the normal authority/readiness boundary. Never emit raw errors.
    try {
      options.onInfrastructureEvent?.({
        code: "idle_connection_error",
        component: "connection_pool",
      });
    } catch {
      // Failed diagnostics cannot turn an infrastructure event into a crash.
    }
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    async checkReady(): Promise<boolean> {
      try {
        await pool.query("select 1");
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
