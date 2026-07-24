import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabaseClient } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const client = createDatabaseClient(databaseUrl);

try {
  await migrate(client.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
} finally {
  await client.close();
}
