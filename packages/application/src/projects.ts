import {
  normalizeEnvironmentVariableName,
  normalizeProjectConfiguration,
  validateEnvironmentVariableValue,
  type ProjectConfiguration,
  type ProjectConfigurationInput,
  type ProjectRuntimeConfig,
} from "@launchrail/domain";

export interface EnvironmentVariableMetadata {
  readonly createdAt: Date;
  readonly id: string;
  readonly name: string;
  readonly updatedAt: Date;
}

export interface ProjectSummary {
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly defaultBranch: string;
  readonly dockerfilePath: string;
  readonly environmentVariables: readonly EnvironmentVariableMetadata[];
  readonly healthCheckPath: string;
  readonly healthCheckPort: number;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly repositoryUrl: string;
  readonly runtimeConfig: ProjectRuntimeConfig;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface ListProjectsQuery {
  readonly actorUserId: string;
  readonly organizationId: string;
}

export interface GetProjectQuery extends ListProjectsQuery {
  readonly projectId: string;
}

export interface CreateProjectCommand extends ListProjectsQuery {
  readonly configuration: ProjectConfigurationInput;
}

export interface UpdateProjectCommand extends GetProjectQuery {
  readonly configuration: ProjectConfigurationInput;
  readonly expectedVersion: number;
}

export interface ArchiveProjectCommand extends GetProjectQuery {
  readonly expectedVersion: number;
}

export interface PutProjectEnvironmentVariableCommand extends GetProjectQuery {
  readonly name: string;
  readonly value: string;
}

export interface DeleteProjectEnvironmentVariableCommand extends GetProjectQuery {
  readonly name: string;
}

export interface CreateProjectRecordCommand extends Omit<CreateProjectCommand, "configuration"> {
  readonly configuration: ProjectConfiguration;
}

export interface UpdateProjectRecordCommand extends Omit<UpdateProjectCommand, "configuration"> {
  readonly configuration: ProjectConfiguration;
}

export interface PutProjectEnvironmentVariableRecordCommand extends Omit<
  PutProjectEnvironmentVariableCommand,
  "name"
> {
  readonly name: string;
}

export interface DeleteProjectEnvironmentVariableRecordCommand extends Omit<
  DeleteProjectEnvironmentVariableCommand,
  "name"
> {
  readonly name: string;
}

export interface ProjectManagementStore {
  archiveProject(command: ArchiveProjectCommand): Promise<ProjectSummary>;
  createProject(command: CreateProjectRecordCommand): Promise<ProjectSummary>;
  deleteEnvironmentVariable(command: DeleteProjectEnvironmentVariableRecordCommand): Promise<void>;
  getProject(query: GetProjectQuery): Promise<ProjectSummary>;
  listProjects(query: ListProjectsQuery): Promise<readonly ProjectSummary[]>;
  putEnvironmentVariable(
    command: PutProjectEnvironmentVariableRecordCommand,
  ): Promise<EnvironmentVariableMetadata>;
  updateProject(command: UpdateProjectRecordCommand): Promise<ProjectSummary>;
}

export type ProjectConflictCode =
  "environment_variable_not_found" | "name_taken" | "project_in_use" | "version_mismatch";

const projectConflictMessages: Readonly<Record<ProjectConflictCode, string>> = {
  environment_variable_not_found: "Environment variable does not exist",
  name_taken: "A project with this name already exists",
  project_in_use: "Project cannot be archived while it is in use",
  version_mismatch: "Project was changed by another request",
};

export class ProjectNotFoundError extends Error {
  public constructor() {
    super("Project not found");
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectConflictError extends Error {
  public readonly code: ProjectConflictCode;

  public constructor(code: ProjectConflictCode) {
    super(projectConflictMessages[code]);
    this.name = "ProjectConflictError";
    this.code = code;
  }
}

export interface SecretContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly variableName: string;
}

export interface EncryptedSecret {
  readonly algorithm: "aes-256-gcm";
  readonly authenticationTag: string;
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
}

export interface SecretCipher {
  decrypt(secret: EncryptedSecret, context: SecretContext): Promise<Uint8Array>;
  encrypt(plaintext: Uint8Array, context: SecretContext): Promise<EncryptedSecret>;
}

export class ListProjects {
  public constructor(private readonly store: ProjectManagementStore) {}

  public execute(query: ListProjectsQuery): Promise<readonly ProjectSummary[]> {
    return this.store.listProjects(query);
  }
}

export class GetProject {
  public constructor(private readonly store: ProjectManagementStore) {}

  public execute(query: GetProjectQuery): Promise<ProjectSummary> {
    return this.store.getProject(query);
  }
}

export class CreateProject {
  public constructor(private readonly store: ProjectManagementStore) {}

  public execute(command: CreateProjectCommand): Promise<ProjectSummary> {
    return this.store.createProject({
      ...command,
      configuration: normalizeProjectConfiguration(command.configuration),
    });
  }
}

export class UpdateProject {
  public constructor(private readonly store: ProjectManagementStore) {}

  public execute(command: UpdateProjectCommand): Promise<ProjectSummary> {
    return this.store.updateProject({
      ...command,
      configuration: normalizeProjectConfiguration(command.configuration),
    });
  }
}

export class ArchiveProject {
  public constructor(private readonly store: ProjectManagementStore) {}

  public execute(command: ArchiveProjectCommand): Promise<ProjectSummary> {
    return this.store.archiveProject(command);
  }
}

export class PutProjectEnvironmentVariable {
  public constructor(private readonly store: ProjectManagementStore) {}

  public execute(
    command: PutProjectEnvironmentVariableCommand,
  ): Promise<EnvironmentVariableMetadata> {
    return this.store.putEnvironmentVariable({
      ...command,
      name: normalizeEnvironmentVariableName(command.name),
      value: validateEnvironmentVariableValue(command.value),
    });
  }
}

export class DeleteProjectEnvironmentVariable {
  public constructor(private readonly store: ProjectManagementStore) {}

  public execute(command: DeleteProjectEnvironmentVariableCommand): Promise<void> {
    return this.store.deleteEnvironmentVariable({
      ...command,
      name: normalizeEnvironmentVariableName(command.name),
    });
  }
}
