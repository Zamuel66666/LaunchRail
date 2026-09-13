CREATE TABLE "health_check_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deployment_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "outcome" text NOT NULL,
  "status_code" integer,
  "duration_ms" integer NOT NULL,
  "checked_at" timestamp with time zone NOT NULL,
  CONSTRAINT "health_check_attempts_deployment_organization_fk" FOREIGN KEY ("deployment_id", "organization_id") REFERENCES "deployments"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "health_check_attempts_outcome" CHECK ("outcome" in ('passed', 'failed')),
  CONSTRAINT "health_check_attempts_status_code" CHECK ("status_code" is null or "status_code" between 100 and 599),
  CONSTRAINT "health_check_attempts_duration" CHECK ("duration_ms" between 0 and 30000)
);
