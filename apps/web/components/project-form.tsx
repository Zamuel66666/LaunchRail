"use client";

import { type FormEvent, useRef, useState } from "react";

import type { ProjectInput, ProjectSummary } from "../lib/api";

interface ProjectFormProps {
  readonly errorMessage: string;
  readonly onCancel: () => void;
  readonly onSave: (input: ProjectInput) => Promise<void>;
  readonly project: ProjectSummary | null;
  readonly submitting: boolean;
}

interface FormValues {
  readonly cpuMillicores: string;
  readonly defaultBranch: string;
  readonly dockerfilePath: string;
  readonly healthCheckPath: string;
  readonly healthCheckPort: string;
  readonly memoryMegabytes: string;
  readonly name: string;
  readonly processLimit: string;
  readonly readOnlyRootFilesystem: boolean;
  readonly repositoryUrl: string;
}

type FieldName = Exclude<keyof FormValues, "readOnlyRootFilesystem">;
type FieldErrors = Partial<Record<FieldName, string>>;

const emptyValues: FormValues = {
  cpuMillicores: "500",
  defaultBranch: "main",
  dockerfilePath: "Dockerfile",
  healthCheckPath: "/health",
  healthCheckPort: "3000",
  memoryMegabytes: "512",
  name: "",
  processLimit: "128",
  readOnlyRootFilesystem: true,
  repositoryUrl: "https://github.com/",
};

function valuesForProject(project: ProjectSummary | null): FormValues {
  if (project === null) {
    return emptyValues;
  }
  return {
    cpuMillicores: String(project.runtimeConfig.cpuMillicores),
    defaultBranch: project.defaultBranch,
    dockerfilePath: project.dockerfilePath,
    healthCheckPath: project.healthCheckPath,
    healthCheckPort: String(project.healthCheckPort),
    memoryMegabytes: String(project.runtimeConfig.memoryMegabytes),
    name: project.name,
    processLimit: String(project.runtimeConfig.processLimit),
    readOnlyRootFilesystem: project.runtimeConfig.readOnlyRootFilesystem,
    repositoryUrl: project.repositoryUrl,
  };
}

function parsePositiveInteger(
  value: string,
  label: string,
  options: { readonly maximum?: number; readonly minimum?: number } = {},
): string | null {
  if (!/^\d+$/.test(value)) {
    return `${label} must be a whole number.`;
  }
  const parsed = Number(value);
  const minimum = options.minimum ?? 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    return `${label} must be at least ${minimum}.`;
  }
  if (options.maximum !== undefined && parsed > options.maximum) {
    return `${label} must be at most ${options.maximum}.`;
  }
  return null;
}

function repositoryError(value: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(value);
  const owner = match?.[1];
  const repository = match?.[2];
  if (
    owner === undefined ||
    repository === undefined ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
    owner.includes("--") ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(repository) ||
    repository === "." ||
    repository === ".." ||
    repository.toLowerCase().endsWith(".git") ||
    value.includes("%") ||
    value.includes("\\")
  ) {
    return "Use a canonical public GitHub HTTPS URL with an owner and repository.";
  }
  return null;
}

function validate(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  if (name.length === 0 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    errors.name = "Project name must be between 1 and 80 characters without control characters.";
  }

  const repository = repositoryError(values.repositoryUrl.trim());
  if (repository !== null) {
    errors.repositoryUrl = repository;
  }

  const branch = values.defaultBranch.trim();
  const branchSegments = branch.split("/");
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith(".") ||
    branch === "@" ||
    branchSegments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.toLowerCase().endsWith(".lock"),
    )
  ) {
    errors.defaultBranch = "Enter a safe Git branch name without spaces or revision syntax.";
  }

  const dockerfilePath = values.dockerfilePath.trim();
  const dockerSegments = dockerfilePath.split("/");
  if (
    dockerfilePath.length === 0 ||
    dockerfilePath.length > 256 ||
    dockerfilePath.startsWith("/") ||
    !/^[A-Za-z0-9._/-]+$/.test(dockerfilePath) ||
    dockerfilePath.includes("\\") ||
    dockerfilePath.includes("%") ||
    dockerSegments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    errors.dockerfilePath = "Use a relative checkout path without empty, dot, or parent segments.";
  }

  const healthPath = values.healthCheckPath.trim();
  if (
    healthPath.length === 0 ||
    healthPath.length > 256 ||
    !healthPath.startsWith("/") ||
    healthPath.startsWith("//") ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(healthPath) ||
    healthPath.includes("//") ||
    healthPath.includes("%") ||
    healthPath.includes("?") ||
    healthPath.includes("#") ||
    healthPath.includes("\\") ||
    healthPath
      .slice(1)
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    errors.healthCheckPath = "Health-check path must start with / and contain no whitespace.";
  }

  const port = parsePositiveInteger(values.healthCheckPort, "Health-check port", {
    maximum: 65_535,
  });
  if (port !== null) errors.healthCheckPort = port;

  const cpu = parsePositiveInteger(values.cpuMillicores, "CPU limit", {
    maximum: 4_000,
    minimum: 100,
  });
  if (cpu !== null) errors.cpuMillicores = cpu;
  const memory = parsePositiveInteger(values.memoryMegabytes, "Memory limit", {
    maximum: 8_192,
    minimum: 64,
  });
  if (memory !== null) errors.memoryMegabytes = memory;
  const processes = parsePositiveInteger(values.processLimit, "Process limit", {
    maximum: 1_024,
    minimum: 16,
  });
  if (processes !== null) errors.processLimit = processes;

  return errors;
}

export function ProjectForm({
  errorMessage,
  onCancel,
  onSave,
  project,
  submitting,
}: ProjectFormProps) {
  const [values, setValues] = useState<FormValues>(() => valuesForProject(project));
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);

  function setField<Field extends keyof FormValues>(field: Field, value: FormValues[Field]): void {
    setValues((current) => ({ ...current, [field]: value }));
    if (field !== "readOnlyRootFilesystem") {
      const errorField = field as FieldName;
      setErrors((current) => {
        const next = { ...current };
        delete next[errorField];
        return next;
      });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextErrors = validate(values);
    setErrors(nextErrors);
    const firstInvalidField = Object.keys(nextErrors)[0];
    if (firstInvalidField !== undefined) {
      requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>(`[name="${firstInvalidField}"]`)?.focus();
      });
      return;
    }

    await onSave({
      defaultBranch: values.defaultBranch.trim(),
      dockerfilePath: values.dockerfilePath.trim(),
      healthCheckPath: values.healthCheckPath.trim(),
      healthCheckPort: Number(values.healthCheckPort),
      name: values.name.trim(),
      repositoryUrl: values.repositoryUrl.trim(),
      runtimeConfig: {
        cpuMillicores: Number(values.cpuMillicores),
        memoryMegabytes: Number(values.memoryMegabytes),
        processLimit: Number(values.processLimit),
        readOnlyRootFilesystem: values.readOnlyRootFilesystem,
      },
    });
  }

  function fieldError(name: FieldName): string | undefined {
    return errors[name];
  }

  return (
    <section className="project-editor" aria-labelledby="project-editor-title">
      <div className="project-editor-heading">
        <div>
          <p className="section-label">{project === null ? "New project" : "Project settings"}</p>
          <h2 id="project-editor-title" tabIndex={-1}>
            {project === null ? "Configure a project" : `Edit ${project.name}`}
          </h2>
        </div>
        <button className="text-button" disabled={submitting} onClick={onCancel} type="button">
          Close
        </button>
      </div>

      <form
        className="project-form"
        noValidate
        onSubmit={(event) => void submit(event)}
        ref={formRef}
      >
        <fieldset disabled={submitting}>
          <legend>Source</legend>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="project-name">Project name</label>
              <input
                aria-describedby={
                  fieldError("name") === undefined ? undefined : "project-name-error"
                }
                aria-invalid={fieldError("name") === undefined ? undefined : true}
                autoComplete="off"
                id="project-name"
                maxLength={80}
                name="name"
                onChange={(event) => setField("name", event.target.value)}
                required
                value={values.name}
              />
              {fieldError("name") === undefined ? null : (
                <p className="field-error" id="project-name-error">
                  {fieldError("name")}
                </p>
              )}
            </div>

            <div className="form-field form-field-wide">
              <label htmlFor="repository-url">GitHub repository URL</label>
              <input
                aria-describedby={
                  fieldError("repositoryUrl") === undefined
                    ? "repository-url-help"
                    : "repository-url-help repository-url-error"
                }
                aria-invalid={fieldError("repositoryUrl") === undefined ? undefined : true}
                autoCapitalize="none"
                autoComplete="url"
                id="repository-url"
                name="repositoryUrl"
                onChange={(event) => setField("repositoryUrl", event.target.value)}
                placeholder="https://github.com/owner/repository"
                required
                spellCheck={false}
                type="url"
                value={values.repositoryUrl}
              />
              <p className="field-help" id="repository-url-help">
                Public github.com HTTPS repositories only. Credentials, query strings, fragments,
                local paths, and alternate hosts are rejected.
              </p>
              {fieldError("repositoryUrl") === undefined ? null : (
                <p className="field-error" id="repository-url-error">
                  {fieldError("repositoryUrl")}
                </p>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="default-branch">Default branch</label>
              <input
                aria-describedby={
                  fieldError("defaultBranch") === undefined ? undefined : "default-branch-error"
                }
                aria-invalid={fieldError("defaultBranch") === undefined ? undefined : true}
                autoCapitalize="none"
                autoComplete="off"
                id="default-branch"
                maxLength={255}
                name="defaultBranch"
                onChange={(event) => setField("defaultBranch", event.target.value)}
                required
                spellCheck={false}
                value={values.defaultBranch}
              />
              {fieldError("defaultBranch") === undefined ? null : (
                <p className="field-error" id="default-branch-error">
                  {fieldError("defaultBranch")}
                </p>
              )}
            </div>
          </div>
        </fieldset>

        <fieldset disabled={submitting}>
          <legend>Build and health</legend>
          <div className="form-grid form-grid-three">
            <div className="form-field">
              <label htmlFor="dockerfile-path">Dockerfile path</label>
              <input
                aria-describedby={
                  fieldError("dockerfilePath") === undefined ? undefined : "dockerfile-path-error"
                }
                aria-invalid={fieldError("dockerfilePath") === undefined ? undefined : true}
                autoCapitalize="none"
                autoComplete="off"
                id="dockerfile-path"
                maxLength={256}
                name="dockerfilePath"
                onChange={(event) => setField("dockerfilePath", event.target.value)}
                required
                spellCheck={false}
                value={values.dockerfilePath}
              />
              {fieldError("dockerfilePath") === undefined ? null : (
                <p className="field-error" id="dockerfile-path-error">
                  {fieldError("dockerfilePath")}
                </p>
              )}
            </div>
            <div className="form-field">
              <label htmlFor="health-path">Health-check path</label>
              <input
                aria-describedby={
                  fieldError("healthCheckPath") === undefined ? undefined : "health-path-error"
                }
                aria-invalid={fieldError("healthCheckPath") === undefined ? undefined : true}
                autoCapitalize="none"
                autoComplete="off"
                id="health-path"
                maxLength={256}
                name="healthCheckPath"
                onChange={(event) => setField("healthCheckPath", event.target.value)}
                required
                spellCheck={false}
                value={values.healthCheckPath}
              />
              {fieldError("healthCheckPath") === undefined ? null : (
                <p className="field-error" id="health-path-error">
                  {fieldError("healthCheckPath")}
                </p>
              )}
            </div>
            <div className="form-field">
              <label htmlFor="health-port">Container port</label>
              <input
                aria-describedby={
                  fieldError("healthCheckPort") === undefined ? undefined : "health-port-error"
                }
                aria-invalid={fieldError("healthCheckPort") === undefined ? undefined : true}
                id="health-port"
                inputMode="numeric"
                max={65_535}
                min={1}
                name="healthCheckPort"
                onChange={(event) => setField("healthCheckPort", event.target.value)}
                required
                type="number"
                value={values.healthCheckPort}
              />
              {fieldError("healthCheckPort") === undefined ? null : (
                <p className="field-error" id="health-port-error">
                  {fieldError("healthCheckPort")}
                </p>
              )}
            </div>
          </div>
        </fieldset>

        <fieldset disabled={submitting}>
          <legend>Runtime limits</legend>
          <div className="form-grid form-grid-three">
            <div className="form-field">
              <label htmlFor="cpu-limit">CPU, millicores</label>
              <input
                aria-describedby={
                  fieldError("cpuMillicores") === undefined ? undefined : "cpu-limit-error"
                }
                aria-invalid={fieldError("cpuMillicores") === undefined ? undefined : true}
                id="cpu-limit"
                inputMode="numeric"
                max={4_000}
                min={100}
                name="cpuMillicores"
                onChange={(event) => setField("cpuMillicores", event.target.value)}
                required
                type="number"
                value={values.cpuMillicores}
              />
              {fieldError("cpuMillicores") === undefined ? null : (
                <p className="field-error" id="cpu-limit-error">
                  {fieldError("cpuMillicores")}
                </p>
              )}
            </div>
            <div className="form-field">
              <label htmlFor="memory-limit">Memory, MB</label>
              <input
                aria-describedby={
                  fieldError("memoryMegabytes") === undefined ? undefined : "memory-limit-error"
                }
                aria-invalid={fieldError("memoryMegabytes") === undefined ? undefined : true}
                id="memory-limit"
                inputMode="numeric"
                max={8_192}
                min={64}
                name="memoryMegabytes"
                onChange={(event) => setField("memoryMegabytes", event.target.value)}
                required
                type="number"
                value={values.memoryMegabytes}
              />
              {fieldError("memoryMegabytes") === undefined ? null : (
                <p className="field-error" id="memory-limit-error">
                  {fieldError("memoryMegabytes")}
                </p>
              )}
            </div>
            <div className="form-field">
              <label htmlFor="process-limit">Process limit</label>
              <input
                aria-describedby={
                  fieldError("processLimit") === undefined ? undefined : "process-limit-error"
                }
                aria-invalid={fieldError("processLimit") === undefined ? undefined : true}
                id="process-limit"
                inputMode="numeric"
                max={1_024}
                min={16}
                name="processLimit"
                onChange={(event) => setField("processLimit", event.target.value)}
                required
                type="number"
                value={values.processLimit}
              />
              {fieldError("processLimit") === undefined ? null : (
                <p className="field-error" id="process-limit-error">
                  {fieldError("processLimit")}
                </p>
              )}
            </div>
          </div>
          <label className="checkbox-field" htmlFor="read-only-filesystem">
            <input
              checked={values.readOnlyRootFilesystem}
              id="read-only-filesystem"
              name="readOnlyRootFilesystem"
              onChange={(event) => setField("readOnlyRootFilesystem", event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>Read-only root filesystem</strong>
              <small>
                Recommended. Runtime writes should use explicitly managed temporary storage.
              </small>
            </span>
          </label>
        </fieldset>

        {errorMessage.length === 0 ? null : (
          <p className="form-message error-message" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="form-actions">
          <button
            className="button-secondary"
            disabled={submitting}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button disabled={submitting} type="submit">
            {submitting ? "Saving…" : project === null ? "Create project" : "Save changes"}
          </button>
        </div>
      </form>
    </section>
  );
}
