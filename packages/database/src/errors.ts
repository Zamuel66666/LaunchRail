export class DeploymentNotFoundError extends Error {
  public constructor() {
    super("Deployment was not found in the requested organization");
    this.name = "DeploymentNotFoundError";
  }
}

export class DeploymentPersistenceConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DeploymentPersistenceConflictError";
  }
}
