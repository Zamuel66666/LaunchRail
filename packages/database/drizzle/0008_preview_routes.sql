CREATE TABLE "preview_routes" (
  "deployment_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "hostname" text NOT NULL,
  "host_port" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "preview_routes_deployment_organization_fk" FOREIGN KEY ("deployment_id", "organization_id") REFERENCES "deployments"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "preview_routes_hostname_unique" UNIQUE("hostname"),
  CONSTRAINT "preview_routes_hostname_format" CHECK ("hostname" ~ '^d-[0-9a-f-]+\\.localhost$'),
  CONSTRAINT "preview_routes_host_port_range" CHECK ("host_port" between 1 and 65535)
);
