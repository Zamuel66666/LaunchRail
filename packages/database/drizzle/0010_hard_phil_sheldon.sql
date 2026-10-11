CREATE TABLE "webhook_deployment_triggers" (
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deployment_triggers_pkey" PRIMARY KEY("organization_id","provider","delivery_id","project_id"),
	CONSTRAINT "webhook_deployment_triggers_deployment_unique" UNIQUE("deployment_id")
);
--> statement-breakpoint
ALTER TABLE "deployment_jobs" DROP CONSTRAINT "deployment_jobs_kind";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "push_payload" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "processing_error" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deployment_triggers" ADD CONSTRAINT "webhook_deployment_triggers_delivery_fk" FOREIGN KEY ("organization_id","provider","delivery_id") REFERENCES "public"."webhook_deliveries"("organization_id","provider","delivery_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deployment_triggers" ADD CONSTRAINT "webhook_deployment_triggers_deployment_fk" FOREIGN KEY ("deployment_id","project_id","organization_id") REFERENCES "public"."deployments"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_kind" CHECK ("deployment_jobs"."kind" in ('deployment.claim', 'deployment.prepare_source', 'deployment.build', 'deployment.start_runtime'));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_attempt_count_bounds" CHECK ("webhook_deliveries"."attempt_count" between 0 and 100);--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_processing_error_format" CHECK ("webhook_deliveries"."processing_error" is null or "webhook_deliveries"."processing_error" ~ '^[a-z][a-z0-9_]{0,63}$');
