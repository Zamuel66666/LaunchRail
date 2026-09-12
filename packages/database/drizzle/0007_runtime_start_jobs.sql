ALTER TABLE "deployment_jobs" DROP CONSTRAINT "deployment_jobs_kind";--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_kind" CHECK ("deployment_jobs"."kind" in ('deployment.claim', 'deployment.prepare_source', 'deployment.build', 'deployment.start_runtime'));--> statement-breakpoint
ALTER TABLE "runtime_instances" ADD CONSTRAINT "runtime_instances_deployment_unique" UNIQUE("deployment_id");
