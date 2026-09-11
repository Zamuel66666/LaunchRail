CREATE TABLE "deployment_build_artifacts" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"checkout_id" text NOT NULL,
	"source_revision" text NOT NULL,
	"tree_revision" text NOT NULL,
	"dockerfile_sha256" text NOT NULL,
	"context_sha256" text NOT NULL,
	"image_reference" text NOT NULL,
	"image_id" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"platform" text NOT NULL,
	"image_size_bytes" bigint NOT NULL,
	"cache_hit_count" integer NOT NULL,
	"cache_miss_count" integer NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_build_artifacts_work_item_unique" UNIQUE("work_item_id"),
	CONSTRAINT "deployment_build_artifacts_image_reference_unique" UNIQUE("image_reference"),
	CONSTRAINT "deployment_build_artifacts_context_sha256_format" CHECK ("deployment_build_artifacts"."context_sha256" ~ '^[0-9a-f]{64}$' AND "deployment_build_artifacts"."context_sha256" <> repeat('0', 64)),
	CONSTRAINT "deployment_build_artifacts_checkout_id_format" CHECK ("deployment_build_artifacts"."checkout_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
	CONSTRAINT "deployment_build_artifacts_source_revision_format" CHECK ("deployment_build_artifacts"."source_revision" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "deployment_build_artifacts_tree_revision_format" CHECK ("deployment_build_artifacts"."tree_revision" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "deployment_build_artifacts_dockerfile_sha256_format" CHECK ("deployment_build_artifacts"."dockerfile_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "deployment_build_artifacts_image_reference_bounds" CHECK (length("deployment_build_artifacts"."image_reference") between 1 and 255
        and "deployment_build_artifacts"."image_reference" = trim("deployment_build_artifacts"."image_reference")
        and "deployment_build_artifacts"."image_reference" !~ '[[:cntrl:]]'),
	CONSTRAINT "deployment_build_artifacts_image_id_format" CHECK ("deployment_build_artifacts"."image_id" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "deployment_build_artifacts_manifest_digest_format" CHECK ("deployment_build_artifacts"."manifest_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "deployment_build_artifacts_platform_format" CHECK (length("deployment_build_artifacts"."platform") between 3 and 64
        and "deployment_build_artifacts"."platform" ~ '^[a-z0-9]+/[a-z0-9._-]+(/[a-z0-9._-]+)?$'),
	CONSTRAINT "deployment_build_artifacts_image_size_bounds" CHECK ("deployment_build_artifacts"."image_size_bytes" between 1 and 1000000000000),
	CONSTRAINT "deployment_build_artifacts_cache_count_bounds" CHECK ("deployment_build_artifacts"."cache_hit_count" between 0 and 1000000
        and "deployment_build_artifacts"."cache_miss_count" between 0 and 1000000)
);
--> statement-breakpoint
CREATE TABLE "deployment_build_log_cursors" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"retained_bytes" bigint DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_build_log_cursors_work_item_unique" UNIQUE("work_item_id"),
	CONSTRAINT "deployment_build_log_cursors_next_sequence_positive" CHECK ("deployment_build_log_cursors"."next_sequence" > 0),
	CONSTRAINT "deployment_build_log_cursors_retained_bytes_bounds" CHECK ("deployment_build_log_cursors"."retained_bytes" between 0 and 1073741824)
);
--> statement-breakpoint
ALTER TABLE "build_logs" DROP CONSTRAINT "build_logs_content_bounded";--> statement-breakpoint
ALTER TABLE "deployment_jobs" DROP CONSTRAINT "deployment_jobs_kind";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "build_logs") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Phase 7 cannot safely assign durable work and attempt identity to legacy build logs';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "build_logs" ADD COLUMN "work_item_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "build_logs" ADD COLUMN "attempt" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_source_preparations" ADD COLUMN "context_sha256" text DEFAULT repeat('0', 64) NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_source_preparations" ALTER COLUMN "context_sha256" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_id_deployment_organization_unique" UNIQUE("id","deployment_id","organization_id");--> statement-breakpoint
ALTER TABLE "deployment_source_preparations" ADD CONSTRAINT "deployment_source_preparations_build_identity_unique" UNIQUE("deployment_id","organization_id","checkout_id","resolved_revision","tree_revision","dockerfile_sha256","context_sha256");--> statement-breakpoint
ALTER TABLE "deployment_build_artifacts" ADD CONSTRAINT "deployment_build_artifacts_deployment_organization_fk" FOREIGN KEY ("deployment_id","organization_id") REFERENCES "public"."deployments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_build_artifacts" ADD CONSTRAINT "deployment_build_artifacts_work_item_fk" FOREIGN KEY ("work_item_id","deployment_id","organization_id") REFERENCES "public"."deployment_jobs"("id","deployment_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_build_artifacts" ADD CONSTRAINT "deployment_build_artifacts_source_identity_fk" FOREIGN KEY ("deployment_id","organization_id","checkout_id","source_revision","tree_revision","dockerfile_sha256","context_sha256") REFERENCES "public"."deployment_source_preparations"("deployment_id","organization_id","checkout_id","resolved_revision","tree_revision","dockerfile_sha256","context_sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_build_log_cursors" ADD CONSTRAINT "deployment_build_log_cursors_work_item_fk" FOREIGN KEY ("work_item_id","deployment_id","organization_id") REFERENCES "public"."deployment_jobs"("id","deployment_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_logs" ADD CONSTRAINT "build_logs_work_item_deployment_organization_fk" FOREIGN KEY ("work_item_id","deployment_id","organization_id") REFERENCES "public"."deployment_jobs"("id","deployment_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_logs_organization_deployment_sequence_index" ON "build_logs" USING btree ("organization_id","deployment_id","sequence");--> statement-breakpoint
ALTER TABLE "build_logs" ADD CONSTRAINT "build_logs_attempt_positive" CHECK ("build_logs"."attempt" > 0);--> statement-breakpoint
ALTER TABLE "build_logs" ADD CONSTRAINT "build_logs_stream" CHECK ("build_logs"."stream" in ('stdout', 'stderr', 'system'));--> statement-breakpoint
ALTER TABLE "build_logs" ADD CONSTRAINT "build_logs_content_bounded" CHECK (octet_length("build_logs"."content") between 1 and 65536);--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_kind" CHECK ("deployment_jobs"."kind" in ('deployment.claim', 'deployment.prepare_source', 'deployment.build'));--> statement-breakpoint
ALTER TABLE "deployment_source_preparations" ADD CONSTRAINT "deployment_source_preparations_context_sha256_format" CHECK ("deployment_source_preparations"."context_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE FUNCTION prevent_deployment_build_artifact_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'deployment build artifact metadata is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER deployment_build_artifacts_immutable
BEFORE UPDATE ON deployment_build_artifacts
FOR EACH ROW
EXECUTE FUNCTION prevent_deployment_build_artifact_changes();
