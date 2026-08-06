"use client";

import { type FormEvent, useId, useState } from "react";

import {
  removeEnvironmentVariable,
  saveEnvironmentVariable,
  type EnvironmentVariableSummary,
  type ProjectSummary,
} from "../lib/api";

interface EnvironmentVariableEditorProps {
  readonly canManage: boolean;
  readonly onVariablesChange: (
    projectId: string,
    variables: readonly EnvironmentVariableSummary[],
  ) => void;
  readonly organizationId: string;
  readonly project: ProjectSummary;
}

const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function EnvironmentVariableEditor({
  canManage,
  onVariablesChange,
  organizationId,
  project,
}: EnvironmentVariableEditorProps) {
  const id = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setMessage("");

    const normalizedName = name.trim().toUpperCase();
    if (!environmentNamePattern.test(normalizedName) || normalizedName.length > 128) {
      setError("Use 1–128 uppercase letters, numbers, or underscores; start with a letter or _.");
      return;
    }
    if (value.length === 0 || new TextEncoder().encode(value).byteLength > 16_384) {
      setError("Enter a value no larger than 16 KiB.");
      return;
    }

    setPending(true);
    const saveRequest = saveEnvironmentVariable(organizationId, project.id, normalizedName, value);
    setValue("");

    try {
      const environmentVariable = await saveRequest;
      const variables = [
        ...project.environmentVariables.filter((item) => item.name !== environmentVariable.name),
        environmentVariable,
      ].sort((left, right) => left.name.localeCompare(right.name));
      onVariablesChange(project.id, variables);
      setName("");
      setMessage(`${environmentVariable.name} was saved. Its value will not be shown again.`);
    } catch {
      setError(
        "The environment variable could not be saved. Its value was cleared; enter it again to retry.",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove(nameToRemove: string): Promise<void> {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await removeEnvironmentVariable(organizationId, project.id, nameToRemove);
      onVariablesChange(
        project.id,
        project.environmentVariables.filter((item) => item.name !== nameToRemove),
      );
      setConfirmingRemoval(null);
      setMessage(`${nameToRemove} was removed.`);
    } catch {
      setError("The environment variable could not be removed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="environment-panel" aria-labelledby={`${id}-title`}>
      <div className="environment-heading">
        <div>
          <p className="section-label">Runtime environment</p>
          <h3 id={`${id}-title`}>Encrypted variables</h3>
        </div>
        <span className="metadata-pill">{project.environmentVariables.length} configured</span>
      </div>
      <p className="environment-intro">
        Stored values are encrypted and write-only. LaunchRail returns names and timestamps, never
        plaintext values.
      </p>

      {project.environmentVariables.length === 0 ? (
        <div className="environment-empty">No environment variables configured.</div>
      ) : (
        <ul className="environment-list" aria-label="Configured environment variables">
          {project.environmentVariables.map((environmentVariable) => (
            <li key={environmentVariable.id}>
              <div>
                <code>{environmentVariable.name}</code>
                <span>Updated {formatDate(environmentVariable.updatedAt)}</span>
              </div>
              {canManage ? (
                <button
                  className="danger-link"
                  disabled={pending}
                  onClick={() => setConfirmingRemoval(environmentVariable.name)}
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {confirmingRemoval === null ? null : (
        <div
          className="inline-confirmation"
          role="alertdialog"
          aria-labelledby={`${id}-remove-title`}
        >
          <div>
            <strong id={`${id}-remove-title`}>Remove {confirmingRemoval}?</strong>
            <p>Future deployments will no longer receive this variable.</p>
          </div>
          <div className="compact-actions">
            <button
              className="text-button"
              disabled={pending}
              onClick={() => setConfirmingRemoval(null)}
              type="button"
            >
              Keep
            </button>
            <button
              className="danger-button"
              disabled={pending}
              onClick={() => void remove(confirmingRemoval)}
              type="button"
            >
              {pending ? "Removing…" : "Remove variable"}
            </button>
          </div>
        </div>
      )}

      {canManage ? (
        <form className="environment-form" onSubmit={(event) => void submit(event)}>
          <div className="form-field">
            <label htmlFor={`${id}-name`}>Variable name</label>
            <input
              autoCapitalize="characters"
              autoComplete="off"
              disabled={pending}
              id={`${id}-name`}
              maxLength={128}
              onChange={(event) => setName(event.target.value.toUpperCase())}
              pattern="[A-Z_][A-Z0-9_]*"
              placeholder="DATABASE_URL"
              required
              spellCheck={false}
              value={name}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-value`}>New value</label>
            <input
              aria-describedby={`${id}-value-help`}
              autoComplete="new-password"
              disabled={pending}
              id={`${id}-value`}
              maxLength={16_384}
              onChange={(event) => setValue(event.target.value)}
              required
              spellCheck={false}
              type="password"
              value={value}
            />
            <p className="field-help" id={`${id}-value-help`}>
              Saving an existing name replaces its value. The field clears before the request
              completes.
            </p>
          </div>
          <button disabled={pending} type="submit">
            {pending ? "Saving…" : "Save encrypted variable"}
          </button>
        </form>
      ) : (
        <p className="permission-note">
          Your role can see variable names but cannot change values.
        </p>
      )}

      <div className="environment-feedback" aria-live="polite">
        {message.length === 0 ? null : <p className="success-message">{message}</p>}
        {error.length === 0 ? null : (
          <p className="form-message error-message" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
