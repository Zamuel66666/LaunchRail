export const deploymentStates = [
  "queued",
  "cloning",
  "building",
  "build_failed",
  "deploying",
  "health_checking",
  "active",
  "deployment_failed",
  "stopped",
  "superseded",
  "cancelling",
  "cancelled",
  "rolling_back",
  "rolled_back",
] as const;

export type DeploymentState = (typeof deploymentStates)[number];

export const deploymentFailureCategories = [
  "source_invalid",
  "source_unavailable",
  "clone_timeout",
  "dockerfile_missing",
  "build_rejected",
  "build_timeout",
  "build_failed",
  "runtime_policy_rejected",
  "runtime_start_failed",
  "runtime_timeout",
  "health_timeout",
  "health_unhealthy",
  "health_invalid_response",
  "route_conflict",
  "route_apply_failed",
  "cancel_timeout",
  "cleanup_failed",
  "infrastructure_unavailable",
  "internal_invariant_violation",
] as const;

export type DeploymentFailureCategory = (typeof deploymentFailureCategories)[number];

const allowedTransitions: Readonly<Record<DeploymentState, ReadonlySet<DeploymentState>>> = {
  active: new Set(["rolling_back", "stopped", "superseded"]),
  build_failed: new Set(),
  building: new Set(["build_failed", "cancelling", "deploying"]),
  cancelled: new Set(),
  cancelling: new Set(["cancelled"]),
  cloning: new Set(["build_failed", "building", "cancelling"]),
  deploying: new Set(["cancelling", "deployment_failed", "health_checking"]),
  deployment_failed: new Set(),
  health_checking: new Set(["active", "cancelling", "deployment_failed"]),
  queued: new Set(["cancelling", "cloning"]),
  rolled_back: new Set(),
  rolling_back: new Set(["active", "rolled_back"]),
  stopped: new Set(),
  superseded: new Set(["active", "stopped"]),
};

export class InvalidDeploymentTransitionError extends Error {
  public readonly from: DeploymentState;
  public readonly to: DeploymentState;

  public constructor(from: DeploymentState, to: DeploymentState) {
    super(`Deployment cannot transition from ${from} to ${to}`);
    this.name = "InvalidDeploymentTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionDeployment(from: DeploymentState, to: DeploymentState): boolean {
  return allowedTransitions[from].has(to);
}

export function assertDeploymentTransition(from: DeploymentState, to: DeploymentState): void {
  if (!canTransitionDeployment(from, to)) {
    throw new InvalidDeploymentTransitionError(from, to);
  }
}

export function requiresFailureDetails(state: DeploymentState): boolean {
  return state === "build_failed" || state === "deployment_failed";
}

export function isTerminalDeploymentState(state: DeploymentState): boolean {
  return (
    state === "build_failed" ||
    state === "cancelled" ||
    state === "deployment_failed" ||
    state === "rolled_back" ||
    state === "stopped"
  );
}
