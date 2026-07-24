import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type LaunchRailDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: LaunchRailDatabase;
  close(): Promise<void>;
}

export function createDatabaseClient(config: PoolConfig | string): DatabaseClient {
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  const db = drizzle(pool, { schema });

  return {
    db,
    close: () => pool.end(),
  };
}
