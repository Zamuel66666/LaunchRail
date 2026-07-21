import { createHealthResponse } from "@launchrail/contracts";

export function GET(): Response {
  return Response.json(createHealthResponse({ service: "web", version: "0.1.0" }));
}
