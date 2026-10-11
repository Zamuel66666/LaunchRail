import { initializeTracing } from "@launchrail/observability";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export const tracingRuntime = initializeTracing({
  ...(endpoint === undefined || endpoint.trim() === "" ? {} : { endpoint }),
  serviceName: "launchrail-api",
  version: "0.1.0",
});
