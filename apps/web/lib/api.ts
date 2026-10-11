export type OrganizationPermission =
  | "audit:read"
  | "deployment:control"
  | "deployment:create"
  | "membership:manage"
  | "membership:read"
  | "organization:manage"
  | "organization:read"
  | "project:create"
  | "project:delete"
  | "project:read"
  | "project:update"
  | "secret:manage"
  | "secret:read-metadata";

export type MembershipRole = "admin" | "developer" | "owner" | "viewer";

export interface Membership {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly permissions: readonly OrganizationPermission[];
  readonly role: MembershipRole;
}

export interface SessionUser {
  readonly displayName: string;
  readonly email: string;
  readonly memberships: readonly Membership[];
  readonly userId: string;
}

export interface RuntimeConfig {
  readonly cpuMillicores: number;
  readonly memoryMegabytes: number;
  readonly processLimit: number;
  readonly readOnlyRootFilesystem: boolean;
}

export interface EnvironmentVariableSummary {
  readonly createdAt: string;
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

export interface ProjectSummary {
  readonly createdAt: string;
  readonly defaultBranch: string;
  readonly dockerfilePath: string;
  readonly environmentVariables: readonly EnvironmentVariableSummary[];
  readonly healthCheckPath: string;
  readonly healthCheckPort: number;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly repositoryUrl: string;
  readonly runtimeConfig: RuntimeConfig;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ProjectInput {
  readonly defaultBranch: string;
  readonly dockerfilePath: string;
  readonly healthCheckPath: string;
  readonly healthCheckPort: number;
  readonly name: string;
  readonly repositoryUrl: string;
  readonly runtimeConfig: RuntimeConfig;
}

export interface DeploymentHistorySummary {
  readonly createdAt: string;
  readonly deploymentId: string;
  readonly finishedAt: string | null;
  readonly healthCheckedAt: string | null;
  readonly projectId: string;
  readonly sourceRevision: string;
  readonly state: string;
}

export interface DeploymentEventSummary {
  readonly createdAt: string;
  readonly fromState: string | null;
  readonly kind: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sequence: number;
  readonly toState: string | null;
}

export interface DeploymentHealthCheckSummary {
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly outcome: "failed" | "passed";
  readonly statusCode: number | null;
}

export interface DeploymentBuildLogSummary {
  readonly attempt: number;
  readonly content: string;
  readonly createdAt: string;
  readonly sequence: number;
  readonly stream: "stderr" | "stdout" | "system";
}

export type DeploymentRuntimeLogs = string;

export interface AuditEventSummary {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly outcome: "failed" | "rejected" | "succeeded";
  readonly targetId: string;
  readonly targetType: string;
}

export interface WebhookDeliverySummary {
  readonly attemptCount: number;
  readonly deliveryId: string;
  readonly duplicate: boolean;
  readonly eventName: string;
  readonly organizationId: string;
  readonly payloadDigest: string;
  readonly processingError: string | null;
  readonly processingState: "failed" | "ignored" | "pending" | "processed";
  readonly provider: string;
  readonly receivedAt: string;
  readonly verificationState: "rejected" | "verified";
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return new ApiError(
      response.status,
      body.error?.code ?? "request_failed",
      body.error?.message ?? "The request could not be completed.",
    );
  } catch {
    return new ApiError(response.status, "request_failed", "The request could not be completed.");
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function organizationPath(organizationId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationId)}/projects`;
}

function projectPath(organizationId: string, projectId: string): string {
  return `${organizationPath(organizationId)}/${encodeURIComponent(projectId)}`;
}

export async function getSession(signal?: AbortSignal): Promise<SessionUser> {
  const response = await apiRequest<{ readonly user: SessionUser }>(
    "/v1/auth/session",
    signal === undefined ? {} : { signal },
  );
  return response.user;
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  const response = await apiRequest<{ readonly user: SessionUser }>("/v1/auth/sign-in", {
    body: JSON.stringify({ email, password }),
    method: "POST",
  });
  return response.user;
}

export async function signOut(): Promise<void> {
  await apiRequest<void>("/v1/auth/sign-out", { method: "POST" });
}

export async function listProjects(
  organizationId: string,
  signal?: AbortSignal,
): Promise<readonly ProjectSummary[]> {
  const response = await apiRequest<{ readonly projects: readonly ProjectSummary[] }>(
    organizationPath(organizationId),
    signal === undefined ? {} : { signal },
  );
  return response.projects;
}

export async function listDeployments(
  organizationId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<readonly DeploymentHistorySummary[]> {
  const response = await apiRequest<{ readonly deployments: readonly DeploymentHistorySummary[] }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/deployments`,
    signal === undefined ? {} : { signal },
  );
  return response.deployments;
}

export async function createDeployment(
  organizationId: string,
  projectId: string,
  sourceRevision: string,
): Promise<DeploymentHistorySummary> {
  const response = await apiRequest<{
    readonly deployment: {
      readonly deploymentId: string;
    };
  }>(`/v1/organizations/${encodeURIComponent(organizationId)}/deployments`, {
    body: JSON.stringify({ projectId, sourceRevision }),
    method: "POST",
  });
  const deployments = await listDeployments(organizationId, projectId);
  const deployment = deployments.find(
    (item) => item.deploymentId === response.deployment.deploymentId,
  );
  if (deployment === undefined) throw new Error("The queued deployment is not visible yet");
  return deployment;
}

export async function listDeploymentEvents(
  organizationId: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<readonly DeploymentEventSummary[]> {
  const response = await apiRequest<{ readonly events: readonly DeploymentEventSummary[] }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/deployments/${encodeURIComponent(deploymentId)}/events?limit=50`,
    signal === undefined ? {} : { signal },
  );
  return response.events;
}

export async function listDeploymentHealthChecks(
  organizationId: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<readonly DeploymentHealthCheckSummary[]> {
  const response = await apiRequest<{ readonly checks: readonly DeploymentHealthCheckSummary[] }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/deployments/${encodeURIComponent(deploymentId)}/health-checks?limit=100`,
    signal === undefined ? {} : { signal },
  );
  return response.checks;
}

export async function listDeploymentBuildLogs(
  organizationId: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<readonly DeploymentBuildLogSummary[]> {
  const response = await apiRequest<{ readonly logs: readonly DeploymentBuildLogSummary[] }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/deployments/${encodeURIComponent(deploymentId)}/build-logs?limit=200`,
    signal === undefined ? {} : { signal },
  );
  return response.logs;
}

export async function getDeploymentRuntimeLogs(
  organizationId: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<DeploymentRuntimeLogs> {
  const response = await apiRequest<{ readonly logs: DeploymentRuntimeLogs }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs?tail=100`,
    signal === undefined ? {} : { signal },
  );
  return response.logs;
}

export async function listAuditEvents(
  organizationId: string,
  targetId: string,
  signal?: AbortSignal,
): Promise<readonly AuditEventSummary[]> {
  const query = new URLSearchParams({ limit: "50", targetId });
  const response = await apiRequest<{ readonly events: readonly AuditEventSummary[] }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/audit-events?${query.toString()}`,
    signal === undefined ? {} : { signal },
  );
  return response.events;
}

export async function listWebhookDeliveries(
  organizationId: string,
  signal?: AbortSignal,
): Promise<readonly WebhookDeliverySummary[]> {
  const response = await apiRequest<{
    readonly deliveries: readonly WebhookDeliverySummary[];
  }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhook-deliveries?limit=100`,
    signal === undefined ? {} : { signal },
  );
  return response.deliveries;
}

export async function retryWebhookDelivery(
  organizationId: string,
  deliveryId: string,
): Promise<WebhookDeliverySummary> {
  const response = await apiRequest<{ readonly delivery: WebhookDeliverySummary }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhook-deliveries/${encodeURIComponent(deliveryId)}/retry`,
    { method: "POST" },
  );
  return response.delivery;
}

export async function retryDeployment(
  organizationId: string,
  deploymentId: string,
): Promise<DeploymentHistorySummary> {
  const response = await apiRequest<{ readonly deployment: DeploymentHistorySummary }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/deployments/${encodeURIComponent(deploymentId)}/retry`,
    { method: "POST" },
  );
  return response.deployment;
}

export async function controlDeployment(
  organizationId: string,
  deploymentId: string,
  action: "cancel" | "promote" | "rollback" | "stop",
): Promise<void> {
  await apiRequest<void>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/deployments/${encodeURIComponent(deploymentId)}/${action}`,
    { method: "POST" },
  );
}

export async function createProject(
  organizationId: string,
  input: ProjectInput,
): Promise<ProjectSummary> {
  const response = await apiRequest<{ readonly project: ProjectSummary }>(
    organizationPath(organizationId),
    { body: JSON.stringify(input), method: "POST" },
  );
  return response.project;
}

export async function updateProject(
  organizationId: string,
  projectId: string,
  input: ProjectInput,
  expectedVersion: number,
): Promise<ProjectSummary> {
  const response = await apiRequest<{ readonly project: ProjectSummary }>(
    projectPath(organizationId, projectId),
    {
      body: JSON.stringify({ ...input, expectedVersion }),
      method: "PATCH",
    },
  );
  return response.project;
}

export async function archiveProject(
  organizationId: string,
  projectId: string,
  expectedVersion: number,
): Promise<void> {
  await apiRequest<void>(projectPath(organizationId, projectId), {
    body: JSON.stringify({ expectedVersion }),
    method: "DELETE",
  });
}

export async function saveEnvironmentVariable(
  organizationId: string,
  projectId: string,
  name: string,
  value: string,
): Promise<EnvironmentVariableSummary> {
  const path = `${projectPath(organizationId, projectId)}/environment-variables/${encodeURIComponent(name)}`;
  const response = await apiRequest<{ readonly environmentVariable: EnvironmentVariableSummary }>(
    path,
    { body: JSON.stringify({ value }), method: "PUT" },
  );
  return response.environmentVariable;
}

export async function removeEnvironmentVariable(
  organizationId: string,
  projectId: string,
  name: string,
): Promise<void> {
  const path = `${projectPath(organizationId, projectId)}/environment-variables/${encodeURIComponent(name)}`;
  await apiRequest<void>(path, { method: "DELETE" });
}
