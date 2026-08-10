CREATE TYPE "public"."deployment_job_status" AS ENUM('pending', 'running', 'retry_wait', 'completed', 'dead_lettered');--> statement-breakpoint
CREATE TYPE "public"."worker_heartbeat_status" AS ENUM('starting', 'ready', 'draining', 'stopped');--> statement-breakpoint
CREATE TABLE "deployment_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"contract_version" integer DEFAULT 1 NOT NULL,
	"status" "deployment_job_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"completed_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_jobs_deployment_kind_unique" UNIQUE("deployment_id","kind"),
	CONSTRAINT "deployment_jobs_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "deployment_jobs_kind" CHECK ("deployment_jobs"."kind" = 'deployment.claim'),
	CONSTRAINT "deployment_jobs_contract_version" CHECK ("deployment_jobs"."contract_version" = 1),
	CONSTRAINT "deployment_jobs_attempt_bounds" CHECK ("deployment_jobs"."attempt_count" >= 0 and "deployment_jobs"."max_attempts" between 1 and 100 and "deployment_jobs"."attempt_count" <= "deployment_jobs"."max_attempts"),
	CONSTRAINT "deployment_jobs_attempt_matches_status" CHECK (("deployment_jobs"."status" = 'pending' and "deployment_jobs"."attempt_count" = 0)
        or ("deployment_jobs"."status" = 'retry_wait' and "deployment_jobs"."attempt_count" > 0 and "deployment_jobs"."attempt_count" < "deployment_jobs"."max_attempts")
        or ("deployment_jobs"."status" = 'dead_lettered' and "deployment_jobs"."attempt_count" = "deployment_jobs"."max_attempts")
        or ("deployment_jobs"."status" = 'running' and "deployment_jobs"."attempt_count" > 0)
        or "deployment_jobs"."status" = 'completed'),
	CONSTRAINT "deployment_jobs_lease_shape" CHECK (("deployment_jobs"."status" = 'running'
          and "deployment_jobs"."lease_token" is not null
          and "deployment_jobs"."worker_id" is not null
          and "deployment_jobs"."heartbeat_at" is not null
          and "deployment_jobs"."lease_expires_at" is not null)
        or ("deployment_jobs"."status" <> 'running'
          and "deployment_jobs"."lease_token" is null
          and "deployment_jobs"."worker_id" is null
          and "deployment_jobs"."heartbeat_at" is null
          and "deployment_jobs"."lease_expires_at" is null)),
	CONSTRAINT "deployment_jobs_lease_order" CHECK ("deployment_jobs"."lease_expires_at" is null or "deployment_jobs"."lease_expires_at" > "deployment_jobs"."heartbeat_at"),
	CONSTRAINT "deployment_jobs_worker_id_format" CHECK ("deployment_jobs"."worker_id" is null or "deployment_jobs"."worker_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "deployment_jobs_failure_shape" CHECK (("deployment_jobs"."status" in ('retry_wait', 'dead_lettered')
          and "deployment_jobs"."last_error_code" is not null
          and "deployment_jobs"."last_error_message" is not null)
        or ("deployment_jobs"."status" not in ('retry_wait', 'dead_lettered')
          and "deployment_jobs"."last_error_code" is null
          and "deployment_jobs"."last_error_message" is null)),
	CONSTRAINT "deployment_jobs_error_code_format" CHECK ("deployment_jobs"."last_error_code" is null or "deployment_jobs"."last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "deployment_jobs_error_message_bounds" CHECK ("deployment_jobs"."last_error_message" is null or (length("deployment_jobs"."last_error_message") between 1 and 512 and "deployment_jobs"."last_error_message" = trim("deployment_jobs"."last_error_message") and "deployment_jobs"."last_error_message" !~ '[[:cntrl:]]')),
	CONSTRAINT "deployment_jobs_completion_shape" CHECK (("deployment_jobs"."status" = 'completed') = ("deployment_jobs"."completed_at" is not null)),
	CONSTRAINT "deployment_jobs_dead_letter_shape" CHECK (("deployment_jobs"."status" = 'dead_lettered') = ("deployment_jobs"."dead_lettered_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"status" "worker_heartbeat_status" NOT NULL,
	"version" text NOT NULL,
	"active_job_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_heartbeats_worker_id_format" CHECK ("worker_heartbeats"."worker_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "worker_heartbeats_version_format" CHECK ("worker_heartbeats"."version" ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
	CONSTRAINT "worker_heartbeats_active_jobs_bounds" CHECK ("worker_heartbeats"."active_job_count" between 0 and 10000),
	CONSTRAINT "worker_heartbeats_time_order" CHECK ("worker_heartbeats"."heartbeat_at" >= "worker_heartbeats"."started_at" and ("worker_heartbeats"."stopped_at" is null or "worker_heartbeats"."stopped_at" >= "worker_heartbeats"."heartbeat_at")),
	CONSTRAINT "worker_heartbeats_stopped_shape" CHECK (("worker_heartbeats"."status" = 'stopped') = ("worker_heartbeats"."stopped_at" is not null)),
	CONSTRAINT "worker_heartbeats_stopped_has_no_active_jobs" CHECK ("worker_heartbeats"."status" <> 'stopped' or "worker_heartbeats"."active_job_count" = 0)
);
--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_deployment_organization_fk" FOREIGN KEY ("deployment_id","organization_id") REFERENCES "public"."deployments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_jobs_dispatch_index" ON "deployment_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "deployment_jobs_expired_lease_index" ON "deployment_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "worker_heartbeats_status_heartbeat_index" ON "worker_heartbeats" USING btree ("status","heartbeat_at");
