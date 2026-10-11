import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type LaunchRailDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: LaunchRailDatabase;
  checkReady(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDatabaseClient(config: PoolConfig | string): DatabaseClient {
  const pool = new Pool(
    typeof config === "string"
      ? { connectionString: config, query_timeout: 2_000 }
      : { query_timeout: 2_000, ...config },
  );
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
