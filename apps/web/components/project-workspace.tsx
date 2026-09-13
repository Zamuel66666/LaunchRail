"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { EnvironmentVariableEditor } from "./environment-variable-editor";
import { ProjectForm } from "./project-form";
import {
  ApiError,
  archiveProject,
  createProject,
  getSession,
  listProjects,
  listDeployments,
  listDeploymentEvents,
  retryDeployment,
  controlDeployment,
  signOut,
  updateProject,
  type EnvironmentVariableSummary,
  type DeploymentEventSummary,
  type DeploymentHistorySummary,
  type Membership,
  type ProjectInput,
  type ProjectSummary,
  type SessionUser,
} from "../lib/api";

type SessionStatus = "checking" | "ready" | "unauthenticated" | "unavailable";
type ProjectsStatus = "idle" | "loading" | "ready" | "unavailable";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function sortProjects(projects: readonly ProjectSummary[]): readonly ProjectSummary[] {
  return [...projects].sort((left, right) => left.name.localeCompare(right.name));
}

function safeRepositoryUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      pathSegments.length === 2
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function actionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return error.message;
  }
  return fallback;
}

type DeploymentControlAction = "cancel" | "rollback" | "stop";

interface PendingDeploymentControl {
  readonly action: DeploymentControlAction;
  readonly deploymentId: string;
}

function deploymentControlCopy(action: DeploymentControlAction): {
  readonly confirm: string;
  readonly label: string;
  readonly pending: string;
} {
  switch (action) {
    case "cancel":
      return {
        confirm: "Cancel deployment",
        label: "Cancel",
        pending: "Cancelling…",
      };
    case "rollback":
      return {
        confirm: "Roll back release",
        label: "Roll back",
        pending: "Rolling back…",
      };
    case "stop":
      return {
        confirm: "Stop release",
        label: "Stop",
        pending: "Stopping…",
      };
  }
}

function LoadingState({ label }: Readonly<{ label: string }>) {
  return (
    <div className="workspace-state" role="status">
      <span className="status-dot" aria-hidden="true" />
      <div>
        <h1>{label}</h1>
        <p>Reading the authoritative LaunchRail state…</p>
      </div>
    </div>
  );
}

function ProjectCard({
  canArchive,
  canEdit,
  canManageSecrets,
  canReadSecrets,
  onArchive,
  onEdit,
  onVariablesChange,
  organizationId,
  project,
}: Readonly<{
  canArchive: boolean;
  canEdit: boolean;
  canManageSecrets: boolean;
  canReadSecrets: boolean;
  onArchive: (project: ProjectSummary) => void;
  onEdit: (project: ProjectSummary) => void;
  onVariablesChange: (projectId: string, variables: readonly EnvironmentVariableSummary[]) => void;
  organizationId: string;
  project: ProjectSummary;
}>) {
  const repositoryUrl = safeRepositoryUrl(project.repositoryUrl);
  const [deployments, setDeployments] = useState<readonly DeploymentHistorySummary[]>([]);
  const [retryingDeploymentId, setRetryingDeploymentId] = useState<string | null>(null);
  const [controllingDeploymentId, setControllingDeploymentId] = useState<string | null>(null);
  const [deploymentActionError, setDeploymentActionError] = useState("");
  const [deploymentEvents, setDeploymentEvents] = useState<
    Readonly<Record<string, readonly DeploymentEventSummary[]>>
  >({});
  const [deploymentEventsError, setDeploymentEventsError] = useState("");
  const [loadingDeploymentEventsId, setLoadingDeploymentEventsId] = useState<string | null>(null);
  const [pendingDeploymentControl, setPendingDeploymentControl] =
    useState<PendingDeploymentControl | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listDeployments(organizationId, project.id, controller.signal)
      .then(setDeployments)
      .catch(() => setDeployments([]));
    return () => controller.abort();
  }, [organizationId, project.id]);

  function requestDeploymentControl(deploymentId: string, action: DeploymentControlAction) {
    setDeploymentActionError("");
    setPendingDeploymentControl({ action, deploymentId });
  }

  function confirmDeploymentControl() {
    if (pendingDeploymentControl === null) return;
    const { action, deploymentId } = pendingDeploymentControl;
    setControllingDeploymentId(deploymentId);
    setDeploymentActionError("");
    void controlDeployment(organizationId, deploymentId, action)
      .then(() => {
        if (action === "rollback") {
          return listDeployments(organizationId, project.id).then(setDeployments);
        }
        const nextState = action === "cancel" ? "cancelling" : "stopped";
        setDeployments((current) =>
          current.map((item) =>
            item.deploymentId === deploymentId ? { ...item, state: nextState } : item,
          ),
        );
      })
      .catch((error: unknown) =>
        setDeploymentActionError(
          actionError(error, "The deployment action could not be completed."),
        ),
      )
      .finally(() => {
        setControllingDeploymentId(null);
        setPendingDeploymentControl(null);
      });
  }

  function loadDeploymentEvents(deploymentId: string) {
    if (deploymentEvents[deploymentId] !== undefined || loadingDeploymentEventsId !== null) return;
    setDeploymentEventsError("");
    setLoadingDeploymentEventsId(deploymentId);
    void listDeploymentEvents(organizationId, deploymentId)
      .then((events) => setDeploymentEvents((current) => ({ ...current, [deploymentId]: events })))
      .catch((error: unknown) =>
        setDeploymentEventsError(actionError(error, "Deployment activity could not be loaded.")),
      )
      .finally(() => setLoadingDeploymentEventsId(null));
  }

  return (
    <article className="project-card">
      <header className="project-card-header">
        <div>
          <p className="section-label">Project</p>
          <h2>{project.name}</h2>
          {repositoryUrl === null ? (
            <span className="repository-warning">Stored repository URL is not safe to open.</span>
          ) : (
            <a href={repositoryUrl} rel="noreferrer" target="_blank">
              {project.repositoryUrl}
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          )}
        </div>
        <span className="metadata-pill">v{project.version}</span>
      </header>

      <dl className="project-facts">
        <div>
          <dt>Branch</dt>
          <dd>{project.defaultBranch}</dd>
        </div>
        <div>
          <dt>Dockerfile</dt>
          <dd>{project.dockerfilePath}</dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>
            :{project.healthCheckPort}
            {project.healthCheckPath}
          </dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>
            {project.runtimeConfig.cpuMillicores}m · {project.runtimeConfig.memoryMegabytes} MB ·{" "}
            {project.runtimeConfig.processLimit} processes
          </dd>
        </div>
        <div>
          <dt>Filesystem</dt>
          <dd>{project.runtimeConfig.readOnlyRootFilesystem ? "Read only" : "Writable"}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(project.updatedAt)}</dd>
        </div>
      </dl>

      <details className="project-details">
        <summary>Deployment timeline</summary>
        {deploymentActionError.length === 0 ? null : (
          <p className="deployment-action-error" role="alert">
            {deploymentActionError}
          </p>
        )}
        {deploymentEventsError.length === 0 ? null : (
          <p className="deployment-action-error" role="alert">
            {deploymentEventsError}
          </p>
        )}
        {pendingDeploymentControl === null ? null : (
          <div className="deployment-control-confirmation" role="alertdialog">
            <p>
              {pendingDeploymentControl.action === "rollback"
                ? "Restore the previous superseded release? The current release will be superseded."
                : pendingDeploymentControl.action === "stop"
                  ? "Stop this active release? Its preview route will be removed."
                  : "Cancel this deployment? Work already in progress will be asked to stop."}
            </p>
            <div className="compact-actions">
              <button
                className="button-secondary"
                disabled={controllingDeploymentId !== null}
                onClick={() => setPendingDeploymentControl(null)}
                type="button"
              >
                Keep running
              </button>
              <button
                className="danger-button"
                disabled={controllingDeploymentId !== null}
                onClick={confirmDeploymentControl}
                type="button"
              >
                {controllingDeploymentId === pendingDeploymentControl.deploymentId
                  ? deploymentControlCopy(pendingDeploymentControl.action).pending
                  : deploymentControlCopy(pendingDeploymentControl.action).confirm}
              </button>
            </div>
          </div>
        )}
        {deployments.length === 0 ? (
          <p className="permission-note">No deployments recorded yet.</p>
        ) : (
          <ol>
            {deployments.map((deployment) => (
              <li key={deployment.deploymentId}>
                <strong>{deployment.state}</strong> · {formatDate(deployment.createdAt)}
                <br />
                <code>{deployment.sourceRevision.slice(0, 12)}</code>
                <details
                  className="deployment-activity"
                  onToggle={(event) => {
                    if (event.currentTarget.open) loadDeploymentEvents(deployment.deploymentId);
                  }}
                >
                  <summary>Activity</summary>
                  {loadingDeploymentEventsId === deployment.deploymentId ? (
                    <p>Loading activity…</p>
                  ) : deploymentEvents[deployment.deploymentId] === undefined ? (
                    <p>Open to load recorded deployment activity.</p>
                  ) : deploymentEvents[deployment.deploymentId]?.length === 0 ? (
                    <p>No activity events recorded.</p>
                  ) : (
                    <ol>
                      {deploymentEvents[deployment.deploymentId]?.map((event) => (
                        <li key={event.sequence}>
                          <strong>{event.kind.replaceAll("_", " ")}</strong>
                          {event.fromState === null || event.toState === null
                            ? ""
                            : ` · ${event.fromState} → ${event.toState}`}
                          <br />
                          <span>{formatDate(event.createdAt)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
                {deployment.state === "build_failed" ||
                deployment.state === "deployment_failed" ||
                deployment.state === "cancelled" ? (
                  <button
                    className="button-secondary"
                    disabled={retryingDeploymentId !== null}
                    onClick={() => {
                      setRetryingDeploymentId(deployment.deploymentId);
                      setDeploymentActionError("");
                      void retryDeployment(organizationId, deployment.deploymentId)
                        .then((retry) => setDeployments((current) => [retry, ...current]))
                        .catch((error: unknown) =>
                          setDeploymentActionError(
                            actionError(error, "The deployment could not be retried."),
                          ),
                        )
                        .finally(() => setRetryingDeploymentId(null));
                    }}
                    type="button"
                  >
                    {retryingDeploymentId === deployment.deploymentId ? "Retrying…" : "Retry"}
                  </button>
                ) : null}
                {["queued", "cloning", "building", "deploying", "health_checking"].includes(
                  deployment.state,
                ) ? (
                  <button
                    className="danger-link"
                    disabled={controllingDeploymentId !== null}
                    onClick={() => requestDeploymentControl(deployment.deploymentId, "cancel")}
                    type="button"
                  >
                    Cancel
                  </button>
                ) : null}
                {deployment.state === "active" ? (
                  <>
                    <button
                      className="button-secondary"
                      disabled={controllingDeploymentId !== null}
                      onClick={() => requestDeploymentControl(deployment.deploymentId, "rollback")}
                      type="button"
                    >
                      Roll back
                    </button>
                    <button
                      className="danger-link"
                      disabled={controllingDeploymentId !== null}
                      onClick={() => requestDeploymentControl(deployment.deploymentId, "stop")}
                      type="button"
                    >
                      Stop
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </details>

      {canEdit || canArchive ? (
        <div className="project-actions">
          {canEdit ? (
            <button className="button-secondary" onClick={() => onEdit(project)} type="button">
              Edit settings
            </button>
          ) : null}
          {canArchive ? (
            <button
              className="danger-link"
              id={`archive-project-${project.id}`}
              onClick={() => onArchive(project)}
              type="button"
            >
              Archive project
            </button>
          ) : null}
        </div>
      ) : (
        <p className="permission-note">Your role has read-only access to this project.</p>
      )}

      {canReadSecrets ? (
        <details className="project-details">
          <summary>Environment variables</summary>
          <EnvironmentVariableEditor
            canManage={canManageSecrets}
            onVariablesChange={onVariablesChange}
            organizationId={organizationId}
            project={project}
          />
        </details>
      ) : (
        <p className="permission-note">Secret metadata is restricted for your role.</p>
      )}
    </article>
  );
}

export function ProjectWorkspace() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("checking");
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [projectsStatus, setProjectsStatus] = useState<ProjectsStatus>("idle");
  const [projectsAttempt, setProjectsAttempt] = useState(0);
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [projectsError, setProjectsError] = useState("");
  const [editorProject, setEditorProject] = useState<ProjectSummary | null | undefined>(undefined);
  const [projectError, setProjectError] = useState("");
  const [savingProject, setSavingProject] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ProjectSummary | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void getSession(controller.signal)
      .then((sessionUser) => {
        setUser(sessionUser);
        setSelectedOrganizationId((current) =>
          sessionUser.memberships.some((membership) => membership.organizationId === current)
            ? current
            : (sessionUser.memberships[0]?.organizationId ?? ""),
        );
        setProjectsStatus(sessionUser.memberships.length === 0 ? "idle" : "loading");
        setSessionStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setUser(null);
        if (error instanceof ApiError && error.status === 401) {
          setSessionStatus("unauthenticated");
        } else {
          setSessionStatus("unavailable");
        }
      });

    return () => controller.abort();
  }, [sessionAttempt]);

  const selectedMembership = useMemo<Membership | undefined>(
    () =>
      user?.memberships.find((membership) => membership.organizationId === selectedOrganizationId),
    [selectedOrganizationId, user],
  );

  useEffect(() => {
    if (sessionStatus !== "ready" || selectedOrganizationId.length === 0) {
      return;
    }

    const controller = new AbortController();

    void listProjects(selectedOrganizationId, controller.signal)
      .then((nextProjects) => {
        setProjects(sortProjects(nextProjects));
        setProjectsStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          setSessionStatus("unauthenticated");
          setUser(null);
          return;
        }
        setProjectsError(
          actionError(error, "LaunchRail could not load projects. Check the API and try again."),
        );
        setProjectsStatus("unavailable");
      });

    return () => controller.abort();
  }, [projectsAttempt, selectedOrganizationId, sessionStatus]);

  const permissions = selectedMembership?.permissions ?? [];
  const canCreate = permissions.includes("project:create");
  const canEdit = permissions.includes("project:update");
  const canArchive = permissions.includes("project:delete");
  const canManageSecrets = permissions.includes("secret:manage");
  const canReadSecrets = permissions.includes("secret:read-metadata");

  function openEditor(project: ProjectSummary | null): void {
    setProjectError("");
    setAnnouncement("");
    setEditorProject(project);
    requestAnimationFrame(() => {
      document.getElementById("project-editor-title")?.focus();
    });
  }

  function openArchiveConfirmation(project: ProjectSummary): void {
    setProjectsError("");
    setAnnouncement("");
    setArchiveTarget(project);
    requestAnimationFrame(() => {
      document.getElementById("archive-project-title")?.focus();
    });
  }

  function changeOrganization(organizationId: string): void {
    setProjects([]);
    setProjectsError("");
    setProjectsStatus("loading");
    setEditorProject(undefined);
    setArchiveTarget(null);
    setSelectedOrganizationId(organizationId);
  }

  function retryProjects(): void {
    setProjects([]);
    setProjectsError("");
    setProjectsStatus("loading");
    setProjectsAttempt((attempt) => attempt + 1);
  }

  async function saveProject(input: ProjectInput): Promise<void> {
    if (selectedMembership === undefined || editorProject === undefined) return;
    setSavingProject(true);
    setProjectError("");
    setAnnouncement("");

    try {
      const saved =
        editorProject === null
          ? await createProject(selectedMembership.organizationId, input)
          : await updateProject(
              selectedMembership.organizationId,
              editorProject.id,
              input,
              editorProject.version,
            );
      setProjects((current) =>
        sortProjects([...current.filter((project) => project.id !== saved.id), saved]),
      );
      setEditorProject(undefined);
      setAnnouncement(
        editorProject === null ? `${saved.name} was created.` : `${saved.name} was updated.`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionStatus("unauthenticated");
        setUser(null);
      } else if (error instanceof ApiError && error.status === 409) {
        setProjectError(
          "This project changed in another session. Close the editor, reload, and try again.",
        );
      } else {
        setProjectError(actionError(error, "The project could not be saved. Try again."));
      }
    } finally {
      setSavingProject(false);
    }
  }

  async function confirmArchive(): Promise<void> {
    if (archiveTarget === null || selectedMembership === undefined) return;
    setArchiving(true);
    setAnnouncement("");
    setProjectsError("");
    try {
      await archiveProject(
        selectedMembership.organizationId,
        archiveTarget.id,
        archiveTarget.version,
      );
      setProjects((current) => current.filter((project) => project.id !== archiveTarget.id));
      setAnnouncement(`${archiveTarget.name} was archived.`);
      setArchiveTarget(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionStatus("unauthenticated");
        setUser(null);
      } else {
        setProjectsError(actionError(error, "The project could not be archived. Try again."));
      }
    } finally {
      setArchiving(false);
    }
  }

  function cancelArchive(): void {
    const targetId = archiveTarget?.id;
    setArchiveTarget(null);
    requestAnimationFrame(() => {
      if (targetId !== undefined) {
        document.getElementById(`archive-project-${targetId}`)?.focus();
      }
    });
  }

  function updateVariables(
    projectId: string,
    variables: readonly EnvironmentVariableSummary[],
  ): void {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId ? { ...project, environmentVariables: variables } : project,
      ),
    );
    setEditorProject((current) =>
      current !== null && current !== undefined && current.id === projectId
        ? { ...current, environmentVariables: variables }
        : current,
    );
  }

  async function endSession(): Promise<void> {
    setSigningOut(true);
    try {
      await signOut();
      setUser(null);
      setProjects([]);
      setSessionStatus("unauthenticated");
    } catch {
      setAnnouncement("Sign-out could not be completed. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  if (sessionStatus === "checking") {
    return (
      <main className="workspace-shell">
        <LoadingState label="Checking your session" />
      </main>
    );
  }

  if (sessionStatus === "unauthenticated") {
    return (
      <main className="workspace-shell">
        <section className="workspace-state" aria-labelledby="sign-in-required-title">
          <div>
            <p className="section-label">Protected workspace</p>
            <h1 id="sign-in-required-title">Sign in to manage projects</h1>
            <p>Your session is missing or expired. Sign in again to continue.</p>
            <Link className="primary-link" href="/sign-in">
              Open secure sign-in <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (sessionStatus === "unavailable") {
    return (
      <main className="workspace-shell">
        <section className="workspace-state" aria-labelledby="service-unavailable-title">
          <div>
            <p className="section-label">Connection problem</p>
            <h1 id="service-unavailable-title">LaunchRail API is unavailable</h1>
            <p>Check the local API and database services, then retry the session check.</p>
            <button
              onClick={() => {
                setSessionStatus("checking");
                setSessionAttempt((attempt) => attempt + 1);
              }}
              type="button"
            >
              Retry connection
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (user === null) return null;

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div>
          <Link className="wordmark workspace-wordmark" href="/">
            LaunchRail
          </Link>
          <p>Project control plane</p>
        </div>
        <div className="workspace-identity">
          <div>
            <strong>{user.displayName}</strong>
            <span>{user.email}</span>
          </div>
          <button
            className="text-button"
            disabled={signingOut}
            onClick={() => void endSession()}
            type="button"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>

      {user.memberships.length === 0 ? (
        <section className="workspace-state" aria-labelledby="no-organizations-title">
          <div>
            <p className="section-label">No workspace</p>
            <h1 id="no-organizations-title">No organization memberships</h1>
            <p>An organization owner must add this account before it can access projects.</p>
          </div>
        </section>
      ) : (
        <>
          <section className="workspace-toolbar" aria-labelledby="projects-title">
            <div>
              <p className="section-label">Organization projects</p>
              <h1 id="projects-title">Configure applications safely</h1>
              <p>
                Repository, build, health, runtime, and encrypted environment settings are kept
                inside the selected organization.
              </p>
            </div>
            <div className="organization-control">
              <label htmlFor="organization-select">Organization</label>
              <select
                id="organization-select"
                onChange={(event) => changeOrganization(event.target.value)}
                value={selectedOrganizationId}
              >
                {user.memberships.map((membership) => (
                  <option key={membership.organizationId} value={membership.organizationId}>
                    {membership.organizationName}
                  </option>
                ))}
              </select>
              {selectedMembership === undefined ? null : (
                <span className={`role role-${selectedMembership.role}`}>
                  {selectedMembership.role}
                </span>
              )}
            </div>
          </section>

          <div className="workspace-announcement" aria-live="polite">
            {announcement.length === 0 ? null : <p className="success-message">{announcement}</p>}
          </div>

          {editorProject === undefined ? null : (
            <ProjectForm
              errorMessage={projectError}
              key={editorProject?.id ?? "new-project"}
              onCancel={() => setEditorProject(undefined)}
              onSave={saveProject}
              project={editorProject}
              submitting={savingProject}
            />
          )}

          {archiveTarget === null ? null : (
            <section
              aria-describedby="archive-project-description"
              aria-labelledby="archive-project-title"
              className="archive-confirmation"
              role="alertdialog"
            >
              <div>
                <p className="section-label">Destructive action</p>
                <h2 id="archive-project-title" tabIndex={-1}>
                  Archive {archiveTarget.name}?
                </h2>
                <p id="archive-project-description">
                  This removes the project configuration from the active workspace. This action
                  cannot be undone from this interface.
                </p>
              </div>
              <div className="compact-actions">
                <button
                  className="button-secondary"
                  disabled={archiving}
                  onClick={cancelArchive}
                  type="button"
                >
                  Keep project
                </button>
                <button
                  className="danger-button"
                  disabled={archiving}
                  onClick={() => void confirmArchive()}
                  type="button"
                >
                  {archiving ? "Archiving…" : "Archive project"}
                </button>
              </div>
            </section>
          )}

          {projectsError.length === 0 ? null : (
            <div className="workspace-error" role="alert">
              <p>{projectsError}</p>
              <button onClick={retryProjects} type="button">
                Reload projects
              </button>
            </div>
          )}

          {projectsStatus === "loading" || projectsStatus === "idle" ? (
            <LoadingState label="Loading projects" />
          ) : projectsStatus === "unavailable" ? null : projects.length === 0 ? (
            <section className="empty-projects" aria-labelledby="empty-projects-title">
              <div className="empty-projects-icon" aria-hidden="true">
                LR
              </div>
              <p className="section-label">Ready for configuration</p>
              <h2 id="empty-projects-title">No projects in this organization</h2>
              <p>
                Add a public GitHub repository and bounded runtime settings. LaunchRail validates
                them again at the API boundary.
              </p>
              {canCreate ? (
                <button onClick={() => openEditor(null)} type="button">
                  Create first project
                </button>
              ) : (
                <p className="permission-note">Your role cannot create projects.</p>
              )}
            </section>
          ) : (
            <section aria-label="Projects" className="projects-section">
              <div className="projects-heading">
                <div>
                  <h2>{projects.length === 1 ? "1 project" : `${projects.length} projects`}</h2>
                  <p>
                    Configuration is authoritative; health-checked deployment controls and release
                    history are available through the API while the operator timeline is being
                    completed.
                  </p>
                </div>
                {canCreate ? (
                  <button onClick={() => openEditor(null)} type="button">
                    New project
                  </button>
                ) : null}
              </div>
              <div className="project-grid">
                {projects.map((project) => (
                  <ProjectCard
                    canArchive={canArchive}
                    canEdit={canEdit}
                    canManageSecrets={canManageSecrets}
                    canReadSecrets={canReadSecrets}
                    key={project.id}
                    onArchive={openArchiveConfirmation}
                    onEdit={openEditor}
                    onVariablesChange={updateVariables}
                    organizationId={selectedOrganizationId}
                    project={project}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
