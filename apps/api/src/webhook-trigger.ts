import type {
  DeploymentCreationStore,
  DeploymentJobStore,
  ProjectManagementStore,
  WebhookDeploymentTrigger,
} from "@launchrail/application";
import { matchesGitHubBranchFilter } from "@launchrail/application";
import type { DeploymentJob } from "@launchrail/contracts";

export interface DeploymentWakeupPublisher {
  enqueue(job: DeploymentJob): Promise<Readonly<{ jobId: string }>>;
}

export interface CreateGitHubWebhookDeploymentTriggerOptions {
  readonly deploymentCreationStore: DeploymentCreationStore;
  readonly deploymentJobStore: Pick<DeploymentJobStore, "ensurePendingClaim">;
  readonly maxAttempts: number;
  readonly onDispatchFailure: (context: Readonly<{ deploymentId: string; error: unknown }>) => void;
  readonly projectStore: Pick<ProjectManagementStore, "listProjects">;
  readonly publisher: DeploymentWakeupPublisher;
}

function matchesRepository(repositoryUrl: string, owner: string, name: string): boolean {
  const repository = new URL(repositoryUrl);
  const [configuredOwner, configuredName] = repository.pathname.slice(1).split("/");
  return configuredOwner === owner && configuredName === name;
}

export function createGitHubWebhookDeploymentTrigger({
  deploymentCreationStore,
  deploymentJobStore,
  maxAttempts,
  onDispatchFailure,
  projectStore,
  publisher,
}: CreateGitHubWebhookDeploymentTriggerOptions): WebhookDeploymentTrigger {
  return {
    async trigger(event) {
      const projects = await projectStore.listProjects({
        actorUserId: "webhook",
        organizationId: event.organizationId,
      });
      for (const project of projects) {
        if (
          !matchesRepository(
            project.repositoryUrl,
            event.push.repositoryOwner,
            event.push.repositoryName,
          ) ||
          !matchesGitHubBranchFilter(event.push.branch, project.defaultBranch)
        ) {
          continue;
        }
        const deployment = await deploymentCreationStore.createDeployment({
          organizationId: event.organizationId,
          projectId: project.id,
          sourceRevision: event.push.revision,
        });
        const ensured = await deploymentJobStore.ensurePendingClaim({
          availableAt: new Date(),
          deploymentId: deployment.deploymentId,
          maxAttempts,
          organizationId: event.organizationId,
        });
        if (ensured.kind === "deployment_not_found" || ensured.kind === "deployment_ineligible") {
          continue;
        }
        try {
          await publisher.enqueue({
            contractVersion: 1,
            kind: "deployment.claim",
            workItemId: ensured.job.id,
          });
        } catch (error) {
          onDispatchFailure({ deploymentId: deployment.deploymentId, error });
        }
      }
    },
  };
}
