ALTER TABLE "deployments" ADD COLUMN "trace_parent" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_trace_parent" CHECK ("deployments"."trace_parent" is null or ("deployments"."trace_parent" ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$' and substring("deployments"."trace_parent" from 4 for 32) <> repeat('0', 32) and substring("deployments"."trace_parent" from 37 for 16) <> repeat('0', 16)));
--> statement-breakpoint
CREATE FUNCTION "launchrail_immutable_trace_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trace_parent IS DISTINCT FROM OLD.trace_parent THEN
    RAISE EXCEPTION 'Deployment trace context is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "deployments_immutable_trace_parent"
BEFORE UPDATE OF "trace_parent" ON "deployments"
FOR EACH ROW EXECUTE FUNCTION "launchrail_immutable_trace_parent"();
