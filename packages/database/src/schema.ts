import { deploymentFailureCategories, deploymentStates } from "@launchrail/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
};

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "developer", "viewer"]);
export const deploymentState = pgEnum("deployment_state", deploymentStates);
export const deploymentFailureCategory = pgEnum(
  "deployment_failure_category",
  deploymentFailureCategories,
);
export const runtimeInstanceState = pgEnum("runtime_instance_state", [
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "orphaned",
]);
export const cleanupState = pgEnum("cleanup_state", [
  "not_required",
  "pending",
  "complete",
  "failed",
]);
export const webhookVerificationState = pgEnum("webhook_verification_state", [
  "verified",
  "rejected",
]);
export const webhookProcessingState = pgEnum("webhook_processing_state", [
  "pending",
  "processed",
  "ignored",
  "failed",
]);
export const auditOutcome = pgEnum("audit_outcome", ["succeeded", "rejected", "failed"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`),
    check("users_email_not_blank", sql`length(trim(${table.email})) > 0`),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("organizations_slug_lower_unique").on(sql`lower(${table.slug})`),
    check("organizations_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("organizations_slug_format", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("memberships_user_id_index").on(table.userId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    repositoryProvider: text("repository_provider").default("github").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    defaultBranch: text("default_branch").default("main").notNull(),
    dockerfilePath: text("dockerfile_path").default("Dockerfile").notNull(),
    healthCheckPath: text("health_check_path").default("/").notNull(),
    healthCheckPort: integer("health_check_port").notNull(),
    runtimeConfig: jsonb("runtime_config").$type<Readonly<Record<string, unknown>>>().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("projects_id_organization_unique").on(table.id, table.organizationId),
    uniqueIndex("projects_name_lower_unique").on(table.organizationId, sql`lower(${table.name})`),
    check("projects_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("projects_health_check_port_range", sql`${table.healthCheckPort} between 1 and 65535`),
  ],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    retryOfDeploymentId: uuid("retry_of_deployment_id"),
    sourceRevision: text("source_revision").notNull(),
    sourceSnapshot: jsonb("source_snapshot").$type<Readonly<Record<string, unknown>>>().notNull(),
    configurationSnapshot: jsonb("configuration_snapshot")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    state: deploymentState("state").default("queued").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    version: integer("version").default(1).notNull(),
    eventSequence: integer("event_sequence").default(0).notNull(),
    failureCategory: deploymentFailureCategory("failure_category"),
    failureMessage: text("failure_message"),
    healthCheckedAt: timestamp("health_checked_at", {
      mode: "date",
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("deployments_id_organization_unique").on(table.id, table.organizationId),
    unique("deployments_id_project_organization_unique").on(
      table.id,
      table.projectId,
      table.organizationId,
    ),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "deployments_project_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.retryOfDeploymentId, table.organizationId],
      foreignColumns: [table.id, table.organizationId],
      name: "deployments_retry_organization_fk",
    }).onDelete("restrict"),
    index("deployments_project_created_index").on(table.projectId, table.createdAt),
    check("deployments_attempt_nonnegative", sql`${table.attempt} >= 0`),
    check("deployments_version_positive", sql`${table.version} > 0`),
    check("deployments_event_sequence_nonnegative", sql`${table.eventSequence} >= 0`),
    check(
      "deployments_source_revision_git_hash",
      sql`${table.sourceRevision} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      "deployments_failure_details_match_state",
      sql`(${table.state} in ('build_failed', 'deployment_failed')) = (${table.failureCategory} is not null and ${table.failureMessage} is not null)`,
    ),
    check(
      "deployments_healthy_release_checked",
      sql`${table.state} not in ('active', 'superseded') or ${table.healthCheckedAt} is not null`,
    ),
  ],
);

export const deploymentEvents = pgTable(
  "deployment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    deploymentId: uuid("deployment_id").notNull(),
    sequence: integer("sequence").notNull(),
    fromState: deploymentState("from_state"),
    toState: deploymentState("to_state").notNull(),
    kind: text("kind").notNull(),
    metadata: jsonb("metadata").$type<Readonly<Record<string, unknown>>>().default({}).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.deploymentId, table.organizationId],
      foreignColumns: [deployments.id, deployments.organizationId],
      name: "deployment_events_deployment_organization_fk",
    }).onDelete("cascade"),
    unique("deployment_events_sequence_unique").on(table.deploymentId, table.sequence),
    index("deployment_events_organization_created_index").on(table.organizationId, table.createdAt),
    check("deployment_events_sequence_positive", sql`${table.sequence} > 0`),
  ],
);

export const buildLogs = pgTable(
  "build_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id").notNull(),
    deploymentId: uuid("deployment_id").notNull(),
    sequence: integer("sequence").notNull(),
    stream: text("stream").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.deploymentId, table.organizationId],
      foreignColumns: [deployments.id, deployments.organizationId],
      name: "build_logs_deployment_organization_fk",
    }).onDelete("cascade"),
    unique("build_logs_sequence_unique").on(table.deploymentId, table.sequence),
    check("build_logs_sequence_positive", sql`${table.sequence} > 0`),
    check("build_logs_content_bounded", sql`octet_length(${table.content}) <= 65536`),
  ],
);

export const runtimeInstances = pgTable(
  "runtime_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    deploymentId: uuid("deployment_id").notNull(),
    containerId: text("container_id"),
    imageDigest: text("image_digest").notNull(),
    state: runtimeInstanceState("state").default("starting").notNull(),
    cleanupState: cleanupState("cleanup_state").default("not_required").notNull(),
    hostPort: integer("host_port"),
    resourceMetadata: jsonb("resource_metadata")
      .$type<Readonly<Record<string, unknown>>>()
      .default({})
      .notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.deploymentId, table.organizationId],
      foreignColumns: [deployments.id, deployments.organizationId],
      name: "runtime_instances_deployment_organization_fk",
    }).onDelete("cascade"),
    unique("runtime_instances_container_unique").on(table.containerId),
    check(
      "runtime_instances_host_port_range",
      sql`${table.hostPort} is null or ${table.hostPort} between 1 and 65535`,
    ),
  ],
);

export const activeReleases = pgTable(
  "active_releases",
  {
    projectId: uuid("project_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    deploymentId: uuid("deployment_id").notNull(),
    activatedAt: timestamp("activated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "active_releases_project_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.deploymentId, table.projectId, table.organizationId],
      foreignColumns: [deployments.id, deployments.projectId, deployments.organizationId],
      name: "active_releases_deployment_project_organization_fk",
    }).onDelete("restrict"),
    unique("active_releases_deployment_unique").on(table.deploymentId),
  ],
);

export const environmentVariables = pgTable(
  "environment_variables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    nonce: text("nonce").notNull(),
    algorithm: text("algorithm").notNull(),
    keyVersion: integer("key_version").notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "environment_variables_project_organization_fk",
    }).onDelete("cascade"),
    unique("environment_variables_project_name_unique").on(table.projectId, table.name),
    check("environment_variables_name_format", sql`${table.name} ~ '^[A-Z_][A-Z0-9_]*$'`),
    check("environment_variables_key_version_positive", sql`${table.keyVersion} > 0`),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    eventName: text("event_name").notNull(),
    verificationState: webhookVerificationState("verification_state").notNull(),
    processingState: webhookProcessingState("processing_state").default("pending").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    unique("webhook_deliveries_provider_id_unique").on(
      table.organizationId,
      table.provider,
      table.deliveryId,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    outcome: auditOutcome("outcome").notNull(),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata").$type<Readonly<Record<string, unknown>>>().default({}).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_organization_created_index").on(table.organizationId, table.createdAt),
  ],
);

export const deploymentCommands = pgTable(
  "deployment_commands",
  {
    deploymentId: uuid("deployment_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    result: jsonb("result")
      .$type<{
        readonly deploymentId: string;
        readonly eventSequence: number;
        readonly from: (typeof deploymentStates)[number];
        readonly to: (typeof deploymentStates)[number];
        readonly version: number;
      }>()
      .notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.deploymentId, table.organizationId],
      foreignColumns: [deployments.id, deployments.organizationId],
      name: "deployment_commands_deployment_organization_fk",
    }).onDelete("cascade"),
    check("deployment_commands_key_not_blank", sql`length(trim(${table.idempotencyKey})) > 0`),
  ],
);
