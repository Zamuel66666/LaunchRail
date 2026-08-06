import { createDatabaseClient } from "./client.js";
import { PostgresIdentityStore } from "./identity-store.js";

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for identity bootstrap`);
  }
  return value;
}

const databaseUrl = requireEnvironment("DATABASE_URL");
const email = requireEnvironment("LAUNCHRAIL_BOOTSTRAP_EMAIL").toLowerCase();
const displayName = requireEnvironment("LAUNCHRAIL_BOOTSTRAP_DISPLAY_NAME");
const organizationName = requireEnvironment("LAUNCHRAIL_BOOTSTRAP_ORGANIZATION_NAME");
const organizationSlug = requireEnvironment("LAUNCHRAIL_BOOTSTRAP_ORGANIZATION_SLUG").toLowerCase();
const password = requireEnvironment("LAUNCHRAIL_BOOTSTRAP_PASSWORD");

if (!email.includes("@") || email.length > 320) {
  throw new Error("LAUNCHRAIL_BOOTSTRAP_EMAIL must be a valid email address");
}
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(organizationSlug)) {
  throw new Error("LAUNCHRAIL_BOOTSTRAP_ORGANIZATION_SLUG has an invalid format");
}
if (Buffer.byteLength(password, "utf8") < 12 || Buffer.byteLength(password, "utf8") > 1024) {
  throw new Error("LAUNCHRAIL_BOOTSTRAP_PASSWORD must be between 12 and 1024 bytes");
}

const client = createDatabaseClient(databaseUrl);

try {
  const identityStore = new PostgresIdentityStore(client.db);
  const principal = await identityStore.bootstrapOwner(
    { displayName, email, organizationName, organizationSlug, password },
    new Date(),
  );
  process.stdout.write(
    `Created LaunchRail owner ${principal.email} for ${principal.memberships[0]?.organizationSlug ?? "organization"}.\n`,
  );
} finally {
  await client.close();
}
