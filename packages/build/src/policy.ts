import { isAbsolute, parse, resolve } from "node:path";

import type {
  BuildImageCommand,
  DeploymentBuildIdentity,
  PreparedBuildContext,
} from "@launchrail/application";

export const launchRailBuildLabelKeys = {
  attempt: "dev.launchrail.build-attempt",
  contextSha256: "dev.launchrail.context-sha256",
  deploymentId: "dev.launchrail.deployment-id",
  dockerfileSha256: "dev.launchrail.dockerfile-sha256",
  managed: "dev.launchrail.managed",
  organizationId: "dev.launchrail.organization-id",
  platform: "dev.launchrail.platform",
  projectId: "dev.launchrail.project-id",
  sourceRevision: "dev.launchrail.source-revision",
  treeRevision: "dev.launchrail.tree-revision",
  workItemId: "dev.launchrail.work-item-id",
} as const;

export type LaunchRailBuildLabelKey =
  (typeof launchRailBuildLabelKeys)[keyof typeof launchRailBuildLabelKeys];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const gitObjectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const builderNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) {
    throw new RangeError(`${field} must be a lowercase UUID`);
  }
}

export function validateBuildCommand(command: BuildImageCommand): void {
  const { identity, context } = command;
  assertUuid(identity.deploymentId, "Deployment ID");
  assertUuid(identity.organizationId, "Organization ID");
  assertUuid(identity.projectId, "Project ID");
  assertUuid(identity.workItemId, "Work item ID");
  if (
    !gitObjectPattern.test(identity.sourceRevision) ||
    !gitObjectPattern.test(identity.treeRevision)
  ) {
    throw new RangeError("Source and tree revisions must be exact lowercase Git object IDs");
  }
  validatePreparedContext(context);
  if (!Number.isSafeInteger(command.attempt) || command.attempt <= 0 || command.attempt > 100) {
    throw new RangeError("Build attempt must be between 1 and 100");
  }
}

export function validatePreparedContext(context: PreparedBuildContext): void {
  if (!sha256Pattern.test(context.contextSha256) || !sha256Pattern.test(context.dockerfileSha256)) {
    throw new RangeError("Prepared build digests must be lowercase SHA-256 values");
  }
  if (
    !isAbsolute(context.contextDirectory) ||
    resolve(context.contextDirectory) !== context.contextDirectory ||
    context.contextDirectory === parse(context.contextDirectory).root
  ) {
    throw new RangeError("Build context must be an absolute normalized non-root path");
  }
  for (const [name, value] of [
    ["Dockerfile path", context.dockerfilePath],
    ["Resolved Dockerfile path", context.dockerfileResolvedPath],
  ] as const) {
    const normalized = value.split("/");
    if (
      value.length === 0 ||
      value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("\0") ||
      normalized.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new RangeError(`${name} must be a safe relative POSIX path`);
    }
  }
}

export function validateBuildIdentity(identity: DeploymentBuildIdentity): void {
  assertUuid(identity.deploymentId, "Deployment ID");
  assertUuid(identity.organizationId, "Organization ID");
  assertUuid(identity.projectId, "Project ID");
  assertUuid(identity.workItemId, "Work item ID");
  if (
    !gitObjectPattern.test(identity.sourceRevision) ||
    !gitObjectPattern.test(identity.treeRevision)
  ) {
    throw new RangeError("Source and tree revisions must be exact lowercase Git object IDs");
  }
}

export function validateBuilderName(value: string): void {
  if (!builderNamePattern.test(value)) {
    throw new RangeError("Buildx builder name contains unsupported characters");
  }
}

export function createStableImageReference(identity: DeploymentBuildIdentity): string {
  return `launchrail.local/launchrail/${identity.projectId}/${identity.deploymentId}:build-v1`;
}

export type BuildLabelRecord = Readonly<Record<LaunchRailBuildLabelKey, string>>;

export function createBuildLabels(
  command: BuildImageCommand,
  platform: "linux/amd64" | "linux/arm64",
  attempt = command.attempt,
): BuildLabelRecord {
  return {
    [launchRailBuildLabelKeys.attempt]: String(attempt),
    [launchRailBuildLabelKeys.contextSha256]: command.context.contextSha256,
    [launchRailBuildLabelKeys.deploymentId]: command.identity.deploymentId,
    [launchRailBuildLabelKeys.dockerfileSha256]: command.context.dockerfileSha256,
    [launchRailBuildLabelKeys.managed]: "true",
    [launchRailBuildLabelKeys.organizationId]: command.identity.organizationId,
    [launchRailBuildLabelKeys.platform]: platform,
    [launchRailBuildLabelKeys.projectId]: command.identity.projectId,
    [launchRailBuildLabelKeys.sourceRevision]: command.identity.sourceRevision,
    [launchRailBuildLabelKeys.treeRevision]: command.identity.treeRevision,
    [launchRailBuildLabelKeys.workItemId]: command.identity.workItemId,
  };
}

export function labelsExactlyMatch(
  actual: Readonly<Record<string, string>>,
  expected: BuildLabelRecord,
): boolean {
  const expectedEntries = Object.entries(expected);
  return expectedEntries.every(([key, value]) => actual[key] === value);
}

export function assertAbsoluteNonRootPath(value: string, name: string): void {
  if (!isAbsolute(value) || resolve(value) !== value || value === parse(value).root) {
    throw new RangeError(`${name} must be an absolute normalized non-root path`);
  }
}
