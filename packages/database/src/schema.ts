import {
  deploymentFailureCategories,
  deploymentStates,
  membershipRoles,
  type ProjectRuntimeConfig,
} from "@launchrail/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

export const membershipRole = pgEnum("membership_role", membershipRoles);
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
export const deploymentJobStatus = pgEnum("deployment_job_status", [
  "pending",
  "running",
  "retry_wait",
  "completed",
  "dead_lettered",
]);
export const workerHeartbeatStatus = pgEnum("worker_heartbeat_status", [
  "starting",
  "ready",
  "draining",
  "stopped",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    disabledAt: timestamp("disabled_at", { mode: "date", withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`),
    check("users_email_not_blank", sql`length(trim(${table.email})) > 0`),
  ],
);

export const passwordCredentials = pgTable(
  "password_credentials",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("password_credentials_hash_not_blank", sql`length(trim(${table.passwordHash})) > 0`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_expires_index").on(table.userId, table.expiresAt),
    check("sessions_token_hash_format", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("sessions_absolute_expiry_order", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "sessions_idle_expiry_order",
      sql`${table.idleExpiresAt} > ${table.createdAt} and ${table.idleExpiresAt} <= ${table.expiresAt}`,
    ),
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
    runtimeConfig: jsonb("runtime_config").$type<ProjectRuntimeConfig>().notNull(),
    version: integer("version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("projects_id_organization_unique").on(table.id, table.organizationId),
    uniqueIndex("projects_active_name_lower_unique")
      .on(table.organizationId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
    index("projects_organization_active_index").on(table.organizationId, table.archivedAt),
    check(
      "projects_name_bounds",
      sql`length(${table.name}) between 1 and 80 and ${table.name} = trim(${table.name})`,
    ),
    check("projects_provider_github", sql`${table.repositoryProvider} = 'github'`),
    check(
      "projects_repository_owner_format",
      sql`${table.repositoryOwner} ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'`,
    ),
    check(
      "projects_repository_name_format",
      sql`length(${table.repositoryName}) between 1 and 100 and ${table.repositoryName} ~ '^[A-Za-z0-9._-]+$' and ${table.repositoryName} not in ('.', '..')`,
    ),
    check(
      "projects_default_branch_bounds",
      sql`length(${table.defaultBranch}) between 1 and 255 and ${table.defaultBranch} !~ '[[:cntrl:] ~^:?*\\\\]'`,
    ),
    check(
      "projects_dockerfile_path_bounds",
      sql`length(${table.dockerfilePath}) between 1 and 256 and ${table.dockerfilePath} !~ '[[:cntrl:]\\\\]' and ${table.dockerfilePath} !~ '^/'`,
    ),
    check(
      "projects_health_path_bounds",
      sql`length(${table.healthCheckPath}) between 1 and 256 and ${table.healthCheckPath} ~ '^/[^?#[:cntrl:]]*$' and ${table.healthCheckPath} !~ '^//'`,
    ),
    check("projects_health_check_port_range", sql`${table.healthCheckPort} between 1 and 65535`),
    check("projects_version_positive", sql`${table.version} > 0`),
    check(
      "projects_runtime_config_shape",
      sql`jsonb_typeof(${table.runtimeConfig}) = 'object'
        and ${table.runtimeConfig} ?& array['cpuMillicores', 'memoryMegabytes', 'processLimit', 'readOnlyRootFilesystem']
        and (${table.runtimeConfig} - array['cpuMillicores', 'memoryMegabytes', 'processLimit', 'readOnlyRootFilesystem']) = '{}'::jsonb
        and jsonb_typeof(${table.runtimeConfig}->'cpuMillicores') = 'number'
        and (${table.runtimeConfig}->>'cpuMillicores')::numeric between 100 and 4000
        and mod((${table.runtimeConfig}->>'cpuMillicores')::numeric, 1) = 0
        and jsonb_typeof(${table.runtimeConfig}->'memoryMegabytes') = 'number'
        and (${table.runtimeConfig}->>'memoryMegabytes')::numeric between 64 and 8192
        and mod((${table.runtimeConfig}->>'memoryMegabytes')::numeric, 1) = 0
        and jsonb_typeof(${table.runtimeConfig}->'processLimit') = 'number'
        and (${table.runtimeConfig}->>'processLimit')::numeric between 16 and 1024
        and mod((${table.runtimeConfig}->>'processLimit')::numeric, 1) = 0
        and jsonb_typeof(${table.runtimeConfig}->'readOnlyRootFilesystem') = 'boolean'`,
    ),
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
    unique("deployments_id_organization_source_revision_unique").on(
      table.id,
      table.organizationId,
      table.sourceRevision,
    ),
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
    workItemId: uuid("work_item_id").notNull(),
    attempt: integer("attempt").notNull(),
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
    foreignKey({
      columns: [table.workItemId, table.deploymentId, table.organizationId],
      foreignColumns: [
        deploymentJobs.id,
        deploymentJobs.deploymentId,
        deploymentJobs.organizationId,
      ],
      name: "build_logs_work_item_deployment_organization_fk",
    }).onDelete("cascade"),
    unique("build_logs_sequence_unique").on(table.deploymentId, table.sequence),
    index("build_logs_organization_deployment_sequence_index").on(
      table.organizationId,
      table.deploymentId,
      table.sequence,
    ),
    check("build_logs_attempt_positive", sql`${table.attempt} > 0`),
    check("build_logs_sequence_positive", sql`${table.sequence} > 0`),
    check("build_logs_stream", sql`${table.stream} in ('stdout', 'stderr', 'system')`),
    check("build_logs_content_bounded", sql`octet_length(${table.content}) between 1 and 65536`),
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
    authTag: text("auth_tag").notNull(),
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
    unique("environment_variables_key_nonce_unique").on(table.keyVersion, table.nonce),
    check(
      "environment_variables_name_format",
      sql`length(${table.name}) between 1 and 128 and ${table.name} ~ '^[A-Z_][A-Z0-9_]*$'`,
    ),
    check(
      "environment_variables_ciphertext_format",
      sql`length(${table.encryptedValue}) between 2 and 22000 and ${table.encryptedValue} ~ '^[A-Za-z0-9_-]+$'`,
    ),
    check("environment_variables_nonce_format", sql`${table.nonce} ~ '^[A-Za-z0-9_-]{16}$'`),
    check("environment_variables_auth_tag_format", sql`${table.authTag} ~ '^[A-Za-z0-9_-]{22}$'`),
    check("environment_variables_algorithm", sql`${table.algorithm} = 'aes-256-gcm'`),
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

export const deploymentSourcePreparations = pgTable(
  "deployment_source_preparations",
  {
    deploymentId: uuid("deployment_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    checkoutId: text("checkout_id").notNull(),
    resolvedRevision: text("resolved_revision").notNull(),
    treeRevision: text("tree_revision").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    dockerfilePath: text("dockerfile_path").notNull(),
    dockerfileResolvedPath: text("dockerfile_resolved_path").notNull(),
    dockerfileSha256: text("dockerfile_sha256").notNull(),
    contextSha256: text("context_sha256").notNull(),
    preparedAt: timestamp("prepared_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.deploymentId, table.organizationId, table.resolvedRevision],
      foreignColumns: [deployments.id, deployments.organizationId, deployments.sourceRevision],
      name: "deployment_source_preparations_deployment_organization_fk",
    }).onDelete("cascade"),
    unique("deployment_source_preparations_checkout_unique").on(table.checkoutId),
    unique("deployment_source_preparations_build_identity_unique").on(
      table.deploymentId,
      table.organizationId,
      table.checkoutId,
      table.resolvedRevision,
      table.treeRevision,
      table.dockerfileSha256,
      table.contextSha256,
    ),
    check(
      "deployment_source_preparations_checkout_id_format",
      sql`${table.checkoutId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    ),
    check(
      "deployment_source_preparations_resolved_revision_hash",
      sql`${table.resolvedRevision} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      "deployment_source_preparations_tree_revision_hash",
      sql`${table.treeRevision} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      "deployment_source_preparations_file_count_bounds",
      sql`${table.fileCount} between 1 and 1000000`,
    ),
    check(
      "deployment_source_preparations_total_bytes_bounds",
      sql`${table.totalBytes} between 1 and 1000000000000`,
    ),
    check(
      "deployment_source_preparations_dockerfile_path_bounds",
      sql`length(${table.dockerfilePath}) between 1 and 256
        and ${table.dockerfilePath} ~ '^[A-Za-z0-9._/-]+$'
        and ${table.dockerfilePath} !~ '[[:cntrl:]]'
        and position(chr(92) in ${table.dockerfilePath}) = 0
        and ${table.dockerfilePath} !~ '^/'
        and ${table.dockerfilePath} !~ '(^|/)\\.\\.?(/|$)'
        and ${table.dockerfilePath} !~ '//'`,
    ),
    check(
      "deployment_source_preparations_dockerfile_sha256_format",
      sql`${table.dockerfileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "deployment_source_preparations_context_sha256_format",
      sql`${table.contextSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "deployment_source_preparations_dockerfile_resolved_path_bounds",
      sql`octet_length(${table.dockerfileResolvedPath}) between 1 and 1024
        and ${table.dockerfileResolvedPath} !~ '[[:cntrl:]]'
        and position(chr(92) in ${table.dockerfileResolvedPath}) = 0
        and ${table.dockerfileResolvedPath} !~ '^/'
        and ${table.dockerfileResolvedPath} !~ '(^|/)\\.\\.?(/|$)'
        and ${table.dockerfileResolvedPath} !~ '//'`,
    ),
  ],
);

export const deploymentJobs = pgTable(
  "deployment_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deploymentId: uuid("deployment_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    kind: text("kind").notNull(),
    contractVersion: integer("contract_version").default(1).notNull(),
    status: deploymentJobStatus("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    availableAt: timestamp("available_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseToken: uuid("lease_token"),
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { mode: "date", withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { mode: "date", withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.deploymentId, table.organizationId],
      foreignColumns: [deployments.id, deployments.organizationId],
      name: "deployment_jobs_deployment_organization_fk",
    }).onDelete("cascade"),
    unique("deployment_jobs_deployment_kind_unique").on(table.deploymentId, table.kind),
    unique("deployment_jobs_id_deployment_organization_unique").on(
      table.id,
      table.deploymentId,
      table.organizationId,
    ),
    unique("deployment_jobs_lease_token_unique").on(table.leaseToken),
    index("deployment_jobs_dispatch_index").on(table.status, table.availableAt),
    index("deployment_jobs_expired_lease_index").on(table.status, table.leaseExpiresAt),
    check(
      "deployment_jobs_kind",
      sql`${table.kind} in ('deployment.claim', 'deployment.prepare_source', 'deployment.build')`,
    ),
    check("deployment_jobs_contract_version", sql`${table.contractVersion} = 1`),
    check(
      "deployment_jobs_attempt_bounds",
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} between 1 and 100 and ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    check(
      "deployment_jobs_attempt_matches_status",
      sql`(${table.status} = 'pending' and ${table.attemptCount} = 0)
        or (${table.status} = 'retry_wait' and ${table.attemptCount} > 0 and ${table.attemptCount} < ${table.maxAttempts})
        or (${table.status} = 'dead_lettered' and ${table.attemptCount} > 0 and ${table.attemptCount} <= ${table.maxAttempts})
        or (${table.status} = 'running' and ${table.attemptCount} > 0)
        or ${table.status} = 'completed'`,
    ),
    check(
      "deployment_jobs_lease_shape",
      sql`(${table.status} = 'running'
          and ${table.leaseToken} is not null
          and ${table.workerId} is not null
          and ${table.heartbeatAt} is not null
          and ${table.leaseExpiresAt} is not null)
        or (${table.status} <> 'running'
          and ${table.leaseToken} is null
          and ${table.workerId} is null
          and ${table.heartbeatAt} is null
          and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      "deployment_jobs_lease_order",
      sql`${table.leaseExpiresAt} is null or ${table.leaseExpiresAt} > ${table.heartbeatAt}`,
    ),
    check(
      "deployment_jobs_worker_id_format",
      sql`${table.workerId} is null or ${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      "deployment_jobs_failure_shape",
      sql`(${table.status} in ('retry_wait', 'dead_lettered')
          and ${table.lastErrorCode} is not null
          and ${table.lastErrorMessage} is not null)
        or (${table.status} not in ('retry_wait', 'dead_lettered')
          and ${table.lastErrorCode} is null
          and ${table.lastErrorMessage} is null)`,
    ),
    check(
      "deployment_jobs_error_code_format",
      sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check(
      "deployment_jobs_error_message_bounds",
      sql`${table.lastErrorMessage} is null or (length(${table.lastErrorMessage}) between 1 and 512 and ${table.lastErrorMessage} = trim(${table.lastErrorMessage}) and ${table.lastErrorMessage} !~ '[[:cntrl:]]')`,
    ),
    check(
      "deployment_jobs_completion_shape",
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)`,
    ),
    check(
      "deployment_jobs_dead_letter_shape",
      sql`(${table.status} = 'dead_lettered') = (${table.deadLetteredAt} is not null)`,
    ),
  ],
);

export const deploymentBuildLogCursors = pgTable(
  "deployment_build_log_cursors",
  {
    deploymentId: uuid("deployment_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workItemId: uuid("work_item_id").notNull(),
    nextSequence: integer("next_sequence").default(1).notNull(),
    retainedBytes: bigint("retained_bytes", { mode: "number" }).default(0).notNull(),
    truncated: boolean("truncated").default(false).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workItemId, table.deploymentId, table.organizationId],
      foreignColumns: [
        deploymentJobs.id,
        deploymentJobs.deploymentId,
        deploymentJobs.organizationId,
      ],
      name: "deployment_build_log_cursors_work_item_fk",
    }).onDelete("cascade"),
    unique("deployment_build_log_cursors_work_item_unique").on(table.workItemId),
    check("deployment_build_log_cursors_next_sequence_positive", sql`${table.nextSequence} > 0`),
    check(
      "deployment_build_log_cursors_retained_bytes_bounds",
      sql`${table.retainedBytes} between 0 and 1073741824`,
    ),
  ],
);

export const deploymentBuildArtifacts = pgTable(
  "deployment_build_artifacts",
  {
    deploymentId: uuid("deployment_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workItemId: uuid("work_item_id").notNull(),
    checkoutId: text("checkout_id").notNull(),
    sourceRevision: text("source_revision").notNull(),
    treeRevision: text("tree_revision").notNull(),
    dockerfileSha256: text("dockerfile_sha256").notNull(),
    contextSha256: text("context_sha256").notNull(),
    imageReference: text("image_reference").notNull(),
    imageId: text("image_id").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    platform: text("platform").notNull(),
    imageSizeBytes: bigint("image_size_bytes", { mode: "number" }).notNull(),
    cacheHitCount: integer("cache_hit_count").notNull(),
    cacheMissCount: integer("cache_miss_count").notNull(),
    builtAt: timestamp("built_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.deploymentId, table.organizationId],
      foreignColumns: [deployments.id, deployments.organizationId],
      name: "deployment_build_artifacts_deployment_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workItemId, table.deploymentId, table.organizationId],
      foreignColumns: [
        deploymentJobs.id,
        deploymentJobs.deploymentId,
        deploymentJobs.organizationId,
      ],
      name: "deployment_build_artifacts_work_item_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.deploymentId,
        table.organizationId,
        table.checkoutId,
        table.sourceRevision,
        table.treeRevision,
        table.dockerfileSha256,
        table.contextSha256,
      ],
      foreignColumns: [
        deploymentSourcePreparations.deploymentId,
        deploymentSourcePreparations.organizationId,
        deploymentSourcePreparations.checkoutId,
        deploymentSourcePreparations.resolvedRevision,
        deploymentSourcePreparations.treeRevision,
        deploymentSourcePreparations.dockerfileSha256,
        deploymentSourcePreparations.contextSha256,
      ],
      name: "deployment_build_artifacts_source_identity_fk",
    }).onDelete("restrict"),
    unique("deployment_build_artifacts_work_item_unique").on(table.workItemId),
    unique("deployment_build_artifacts_image_reference_unique").on(table.imageReference),
    check(
      "deployment_build_artifacts_context_sha256_format",
      sql`${table.contextSha256} ~ '^[0-9a-f]{64}$'
        and ${table.contextSha256} <> repeat('0', 64)`,
    ),
    check(
      "deployment_build_artifacts_checkout_id_format",
      sql`${table.checkoutId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    ),
    check(
      "deployment_build_artifacts_source_revision_format",
      sql`${table.sourceRevision} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      "deployment_build_artifacts_tree_revision_format",
      sql`${table.treeRevision} ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'`,
    ),
    check(
      "deployment_build_artifacts_dockerfile_sha256_format",
      sql`${table.dockerfileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "deployment_build_artifacts_image_reference_bounds",
      sql`length(${table.imageReference}) between 1 and 255
        and ${table.imageReference} = trim(${table.imageReference})
        and ${table.imageReference} !~ '[[:cntrl:]]'`,
    ),
    check(
      "deployment_build_artifacts_image_id_format",
      sql`${table.imageId} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      "deployment_build_artifacts_manifest_digest_format",
      sql`${table.manifestDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      "deployment_build_artifacts_platform_format",
      sql`length(${table.platform}) between 3 and 64
        and ${table.platform} ~ '^[a-z0-9]+/[a-z0-9._-]+(/[a-z0-9._-]+)?$'`,
    ),
    check(
      "deployment_build_artifacts_image_size_bounds",
      sql`${table.imageSizeBytes} between 1 and 1000000000000`,
    ),
    check(
      "deployment_build_artifacts_cache_count_bounds",
      sql`${table.cacheHitCount} between 0 and 1000000
        and ${table.cacheMissCount} between 0 and 1000000`,
    ),
  ],
);

export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    workerId: text("worker_id").primaryKey(),
    status: workerHeartbeatStatus("status").notNull(),
    version: text("version").notNull(),
    activeJobCount: integer("active_job_count").default(0).notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { mode: "date", withTimezone: true }).notNull(),
    stoppedAt: timestamp("stopped_at", { mode: "date", withTimezone: true }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("worker_heartbeats_status_heartbeat_index").on(table.status, table.heartbeatAt),
    check(
      "worker_heartbeats_worker_id_format",
      sql`${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      "worker_heartbeats_version_format",
      sql`${table.version} ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'`,
    ),
    check("worker_heartbeats_active_jobs_bounds", sql`${table.activeJobCount} between 0 and 10000`),
    check(
      "worker_heartbeats_time_order",
      sql`${table.heartbeatAt} >= ${table.startedAt} and (${table.stoppedAt} is null or ${table.stoppedAt} >= ${table.heartbeatAt})`,
    ),
    check(
      "worker_heartbeats_stopped_shape",
      sql`(${table.status} = 'stopped') = (${table.stoppedAt} is not null)`,
    ),
    check(
      "worker_heartbeats_stopped_has_no_active_jobs",
      sql`${table.status} <> 'stopped' or ${table.activeJobCount} = 0`,
    ),
  ],
);
