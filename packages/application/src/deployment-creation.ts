export interface CreateDeploymentCommand {
  readonly actorUserId?: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly retryOfDeploymentId?: string;
  readonly sourceRevision?: string;
}

export interface CreatedDeployment {
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly sourceRevision: string;
}

export interface DeploymentCreationStore {
  createDeployment(command: CreateDeploymentCommand): Promise<CreatedDeployment>;
}
