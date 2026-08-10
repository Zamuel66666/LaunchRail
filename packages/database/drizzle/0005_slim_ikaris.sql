CREATE TABLE "deployment_source_preparations" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"checkout_id" text NOT NULL,
	"resolved_revision" text NOT NULL,
	"tree_revision" text NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"dockerfile_path" text NOT NULL,
	"dockerfile_resolved_path" text NOT NULL,
	"dockerfile_sha256" text NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_source_preparations_checkout_unique" UNIQUE("checkout_id"),
	CONSTRAINT "deployment_source_preparations_checkout_id_format" CHECK ("deployment_source_preparations"."checkout_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
	CONSTRAINT "deployment_source_preparations_resolved_revision_hash" CHECK ("deployment_source_preparations"."resolved_revision" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "deployment_source_preparations_tree_revision_hash" CHECK ("deployment_source_preparations"."tree_revision" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "deployment_source_preparations_file_count_bounds" CHECK ("deployment_source_preparations"."file_count" between 1 and 1000000),
	CONSTRAINT "deployment_source_preparations_total_bytes_bounds" CHECK ("deployment_source_preparations"."total_bytes" between 1 and 1000000000000),
	CONSTRAINT "deployment_source_preparations_dockerfile_path_bounds" CHECK (length("deployment_source_preparations"."dockerfile_path") between 1 and 256
        and "deployment_source_preparations"."dockerfile_path" ~ '^[A-Za-z0-9._/-]+$'
        and "deployment_source_preparations"."dockerfile_path" !~ '[[:cntrl:]]'
        and position(chr(92) in "deployment_source_preparations"."dockerfile_path") = 0
        and "deployment_source_preparations"."dockerfile_path" !~ '^/'
        and "deployment_source_preparations"."dockerfile_path" !~ '(^|/)\.\.?(/|$)'
        and "deployment_source_preparations"."dockerfile_path" !~ '//'),
	CONSTRAINT "deployment_source_preparations_dockerfile_sha256_format" CHECK ("deployment_source_preparations"."dockerfile_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "deployment_source_preparations_dockerfile_resolved_path_bounds" CHECK (octet_length("deployment_source_preparations"."dockerfile_resolved_path") between 1 and 1024
        and "deployment_source_preparations"."dockerfile_resolved_path" !~ '[[:cntrl:]]'
        and position(chr(92) in "deployment_source_preparations"."dockerfile_resolved_path") = 0
        and "deployment_source_preparations"."dockerfile_resolved_path" !~ '^/'
        and "deployment_source_preparations"."dockerfile_resolved_path" !~ '(^|/)\.\.?(/|$)'
        and "deployment_source_preparations"."dockerfile_resolved_path" !~ '//')
);
--> statement-breakpoint
ALTER TABLE "deployment_jobs" DROP CONSTRAINT "deployment_jobs_kind";--> statement-breakpoint
ALTER TABLE "deployment_jobs" DROP CONSTRAINT "deployment_jobs_attempt_matches_status";--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_id_organization_source_revision_unique" UNIQUE("id","organization_id","source_revision");--> statement-breakpoint
ALTER TABLE "deployment_source_preparations" ADD CONSTRAINT "deployment_source_preparations_deployment_organization_fk" FOREIGN KEY ("deployment_id","organization_id","resolved_revision") REFERENCES "public"."deployments"("id","organization_id","source_revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_kind" CHECK ("deployment_jobs"."kind" in ('deployment.claim', 'deployment.prepare_source'));--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_attempt_matches_status" CHECK (("deployment_jobs"."status" = 'pending' and "deployment_jobs"."attempt_count" = 0)
        or ("deployment_jobs"."status" = 'retry_wait' and "deployment_jobs"."attempt_count" > 0 and "deployment_jobs"."attempt_count" < "deployment_jobs"."max_attempts")
        or ("deployment_jobs"."status" = 'dead_lettered' and "deployment_jobs"."attempt_count" > 0 and "deployment_jobs"."attempt_count" <= "deployment_jobs"."max_attempts")
        or ("deployment_jobs"."status" = 'running' and "deployment_jobs"."attempt_count" > 0)
        or "deployment_jobs"."status" = 'completed');--> statement-breakpoint
CREATE FUNCTION prevent_deployment_source_preparation_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'prepared deployment source metadata is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER deployment_source_preparations_immutable
BEFORE UPDATE ON deployment_source_preparations
FOR EACH ROW
EXECUTE FUNCTION prevent_deployment_source_preparation_changes();
