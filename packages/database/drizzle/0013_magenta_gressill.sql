CREATE TABLE "rollback_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_deployment_id" uuid NOT NULL,
	"target_deployment_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"worker_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rollback_requests_source_key_unique" UNIQUE("source_deployment_id","idempotency_key"),
	CONSTRAINT "rollback_requests_status" CHECK ("rollback_requests"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "rollback_requests_attempt_bounds" CHECK ("rollback_requests"."attempt_count" between 0 and 3),
	CONSTRAINT "rollback_requests_distinct_releases" CHECK ("rollback_requests"."source_deployment_id" <> "rollback_requests"."target_deployment_id"),
	CONSTRAINT "rollback_requests_lease" CHECK (("rollback_requests"."status" = 'running') = ("rollback_requests"."lease_token" is not null and "rollback_requests"."lease_expires_at" is not null and "rollback_requests"."worker_id" is not null)),
	CONSTRAINT "rollback_requests_error" CHECK ("rollback_requests"."error_code" is null or "rollback_requests"."error_code" in ('rollback_unhealthy', 'rollback_infrastructure_unavailable', 'rollback_invalid_snapshot', 'rollback_lease_exhausted', 'rollback_state_conflict'))
);
--> statement-breakpoint
ALTER TABLE "rollback_requests" ADD CONSTRAINT "rollback_requests_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollback_requests" ADD CONSTRAINT "rollback_requests_source_owner_fk" FOREIGN KEY ("source_deployment_id","project_id","organization_id") REFERENCES "public"."deployments"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollback_requests" ADD CONSTRAINT "rollback_requests_target_owner_fk" FOREIGN KEY ("target_deployment_id","project_id","organization_id") REFERENCES "public"."deployments"("id","project_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rollback_requests_pending_index" ON "rollback_requests" USING btree ("status","created_at");