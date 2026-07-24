CREATE TYPE "public"."audit_outcome" AS ENUM('succeeded', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cleanup_state" AS ENUM('not_required', 'pending', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."deployment_failure_category" AS ENUM('source_invalid', 'source_unavailable', 'clone_timeout', 'dockerfile_missing', 'build_rejected', 'build_timeout', 'build_failed', 'runtime_policy_rejected', 'runtime_start_failed', 'runtime_timeout', 'health_timeout', 'health_unhealthy', 'health_invalid_response', 'route_conflict', 'route_apply_failed', 'cancel_timeout', 'cleanup_failed', 'infrastructure_unavailable', 'internal_invariant_violation');--> statement-breakpoint
CREATE TYPE "public"."deployment_state" AS ENUM('queued', 'cloning', 'building', 'build_failed', 'deploying', 'health_checking', 'active', 'deployment_failed', 'stopped', 'superseded', 'cancelling', 'cancelled', 'rolling_back', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'developer', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."runtime_instance_state" AS ENUM('starting', 'running', 'stopping', 'stopped', 'failed', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."webhook_processing_state" AS ENUM('pending', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_verification_state" AS ENUM('verified', 'rejected');--> statement-breakpoint
CREATE TABLE "active_releases" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "active_releases_deployment_unique" UNIQUE("deployment_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"correlation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "build_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stream" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_logs_sequence_unique" UNIQUE("deployment_id","sequence"),
	CONSTRAINT "build_logs_sequence_positive" CHECK ("build_logs"."sequence" > 0),
	CONSTRAINT "build_logs_content_bounded" CHECK (octet_length("build_logs"."content") <= 65536)
);
--> statement-breakpoint
CREATE TABLE "deployment_commands" (
	"deployment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_commands_deployment_id_idempotency_key_pk" PRIMARY KEY("deployment_id","idempotency_key"),
	CONSTRAINT "deployment_commands_key_not_blank" CHECK (length(trim("deployment_commands"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "deployment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"from_state" "deployment_state",
	"to_state" "deployment_state" NOT NULL,
	"kind" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_events_sequence_unique" UNIQUE("deployment_id","sequence"),
	CONSTRAINT "deployment_events_sequence_positive" CHECK ("deployment_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"retry_of_deployment_id" uuid,
	"source_revision" text NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"configuration_snapshot" jsonb NOT NULL,
	"state" "deployment_state" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"event_sequence" integer DEFAULT 0 NOT NULL,
	"failure_category" "deployment_failure_category",
	"failure_message" text,
	"health_checked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "deployments_id_project_organization_unique" UNIQUE("id","project_id","organization_id"),
	CONSTRAINT "deployments_attempt_nonnegative" CHECK ("deployments"."attempt" >= 0),
	CONSTRAINT "deployments_version_positive" CHECK ("deployments"."version" > 0),
	CONSTRAINT "deployments_event_sequence_nonnegative" CHECK ("deployments"."event_sequence" >= 0),
	CONSTRAINT "deployments_source_revision_git_hash" CHECK ("deployments"."source_revision" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "deployments_failure_details_match_state" CHECK (("deployments"."state" in ('build_failed', 'deployment_failed')) = ("deployments"."failure_category" is not null and "deployments"."failure_message" is not null)),
	CONSTRAINT "deployments_healthy_release_checked" CHECK ("deployments"."state" not in ('active', 'superseded') or "deployments"."health_checked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "environment_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"nonce" text NOT NULL,
	"algorithm" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_variables_project_name_unique" UNIQUE("project_id","name"),
	CONSTRAINT "environment_variables_name_format" CHECK ("environment_variables"."name" ~ '^[A-Z_][A-Z0-9_]*$'),
	CONSTRAINT "environment_variables_key_version_positive" CHECK ("environment_variables"."key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_name_not_blank" CHECK (length(trim("organizations"."name")) > 0),
	CONSTRAINT "organizations_slug_format" CHECK ("organizations"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"repository_provider" text DEFAULT 'github' NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"dockerfile_path" text DEFAULT 'Dockerfile' NOT NULL,
	"health_check_path" text DEFAULT '/' NOT NULL,
	"health_check_port" integer NOT NULL,
	"runtime_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "projects_name_not_blank" CHECK (length(trim("projects"."name")) > 0),
	CONSTRAINT "projects_health_check_port_range" CHECK ("projects"."health_check_port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "runtime_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"container_id" text,
	"image_digest" text NOT NULL,
	"state" "runtime_instance_state" DEFAULT 'starting' NOT NULL,
	"cleanup_state" "cleanup_state" DEFAULT 'not_required' NOT NULL,
	"host_port" integer,
	"resource_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_instances_container_unique" UNIQUE("container_id"),
	CONSTRAINT "runtime_instances_host_port_range" CHECK ("runtime_instances"."host_port" is null or "runtime_instances"."host_port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_not_blank" CHECK (length(trim("users"."email")) > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_name" text NOT NULL,
	"verification_state" "webhook_verification_state" NOT NULL,
	"processing_state" "webhook_processing_state" DEFAULT 'pending' NOT NULL,
	"payload_digest" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_provider_id_unique" UNIQUE("organization_id","provider","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "active_releases" ADD CONSTRAINT "active_releases_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_releases" ADD CONSTRAINT "active_releases_deployment_project_organization_fk" FOREIGN KEY ("deployment_id","project_id","organization_id") REFERENCES "public"."deployments"("id","project_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_logs" ADD CONSTRAINT "build_logs_deployment_organization_fk" FOREIGN KEY ("deployment_id","organization_id") REFERENCES "public"."deployments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_commands" ADD CONSTRAINT "deployment_commands_deployment_organization_fk" FOREIGN KEY ("deployment_id","organization_id") REFERENCES "public"."deployments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deployment_organization_fk" FOREIGN KEY ("deployment_id","organization_id") REFERENCES "public"."deployments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_retry_organization_fk" FOREIGN KEY ("retry_of_deployment_id","organization_id") REFERENCES "public"."deployments"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_instances" ADD CONSTRAINT "runtime_instances_deployment_organization_fk" FOREIGN KEY ("deployment_id","organization_id") REFERENCES "public"."deployments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_organization_created_index" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "deployment_events_organization_created_index" ON "deployment_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_project_created_index" ON "deployments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "memberships_user_id_index" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_lower_unique" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_lower_unique" ON "projects" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"));