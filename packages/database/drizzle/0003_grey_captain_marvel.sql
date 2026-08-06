ALTER TABLE "environment_variables" DROP CONSTRAINT "environment_variables_name_format";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_name_not_blank";--> statement-breakpoint
DROP INDEX "projects_name_lower_unique";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "environment_variables") THEN
		RAISE EXCEPTION 'Phase 4 cannot authenticate legacy environment variable ciphertext; back up and re-enter those values before migrating';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "environment_variables" ADD COLUMN "auth_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_active_name_lower_unique" ON "projects" USING btree ("organization_id",lower("name")) WHERE "projects"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "projects_organization_active_index" ON "projects" USING btree ("organization_id","archived_at");--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_key_nonce_unique" UNIQUE("key_version","nonce");--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_ciphertext_format" CHECK (length("environment_variables"."encrypted_value") between 2 and 22000 and "environment_variables"."encrypted_value" ~ '^[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_nonce_format" CHECK ("environment_variables"."nonce" ~ '^[A-Za-z0-9_-]{16}$');--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_auth_tag_format" CHECK ("environment_variables"."auth_tag" ~ '^[A-Za-z0-9_-]{22}$');--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_algorithm" CHECK ("environment_variables"."algorithm" = 'aes-256-gcm');--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_name_format" CHECK (length("environment_variables"."name") between 1 and 128 and "environment_variables"."name" ~ '^[A-Z_][A-Z0-9_]*$');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_name_bounds" CHECK (length("projects"."name") between 1 and 80 and "projects"."name" = trim("projects"."name"));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_provider_github" CHECK ("projects"."repository_provider" = 'github');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_repository_owner_format" CHECK ("projects"."repository_owner" ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_repository_name_format" CHECK (length("projects"."repository_name") between 1 and 100 and "projects"."repository_name" ~ '^[A-Za-z0-9._-]+$' and "projects"."repository_name" not in ('.', '..'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_branch_bounds" CHECK (length("projects"."default_branch") between 1 and 255 and "projects"."default_branch" !~ '[[:cntrl:] ~^:?*\\]');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_dockerfile_path_bounds" CHECK (length("projects"."dockerfile_path") between 1 and 256 and "projects"."dockerfile_path" !~ '[[:cntrl:]\\]' and "projects"."dockerfile_path" !~ '^/');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_health_path_bounds" CHECK (length("projects"."health_check_path") between 1 and 256 and "projects"."health_check_path" ~ '^/[^?#[:cntrl:]]*$' and "projects"."health_check_path" !~ '^//');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_version_positive" CHECK ("projects"."version" > 0);--> statement-breakpoint
UPDATE "projects"
SET "runtime_config" = '{"cpuMillicores":500,"memoryMegabytes":512,"processLimit":256,"readOnlyRootFilesystem":true}'::jsonb
WHERE "runtime_config" = '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_runtime_config_shape" CHECK (jsonb_typeof("projects"."runtime_config") = 'object'
        and "projects"."runtime_config" ?& array['cpuMillicores', 'memoryMegabytes', 'processLimit', 'readOnlyRootFilesystem']
        and ("projects"."runtime_config" - array['cpuMillicores', 'memoryMegabytes', 'processLimit', 'readOnlyRootFilesystem']) = '{}'::jsonb
        and jsonb_typeof("projects"."runtime_config"->'cpuMillicores') = 'number'
        and ("projects"."runtime_config"->>'cpuMillicores')::numeric between 100 and 4000
        and mod(("projects"."runtime_config"->>'cpuMillicores')::numeric, 1) = 0
        and jsonb_typeof("projects"."runtime_config"->'memoryMegabytes') = 'number'
        and ("projects"."runtime_config"->>'memoryMegabytes')::numeric between 64 and 8192
        and mod(("projects"."runtime_config"->>'memoryMegabytes')::numeric, 1) = 0
        and jsonb_typeof("projects"."runtime_config"->'processLimit') = 'number'
        and ("projects"."runtime_config"->>'processLimit')::numeric between 16 and 1024
        and mod(("projects"."runtime_config"->>'processLimit')::numeric, 1) = 0
        and jsonb_typeof("projects"."runtime_config"->'readOnlyRootFilesystem') = 'boolean');
