export const launchRailServices = ["api", "web", "worker"] as const;

export type LaunchRailService = (typeof launchRailServices)[number];

export interface HealthResponse {
  readonly service: LaunchRailService;
  readonly status: "ok";
  readonly timestamp: string;
  readonly version: string;
}

interface CreateHealthResponseOptions {
  readonly now?: (() => Date) | undefined;
  readonly service: LaunchRailService;
  readonly version: string;
}

export function createHealthResponse({
  now = () => new Date(),
  service,
  version,
}: CreateHealthResponseOptions): HealthResponse {
  return {
    service,
    status: "ok",
    timestamp: now().toISOString(),
    version,
  };
}
