import type { BuildLogChunk, BuildLogSink, BuildLogStream } from "@launchrail/application";

export class BuildProgressFormatError extends Error {
  public constructor() {
    super("BuildKit returned invalid progress data");
    this.name = "BuildProgressFormatError";
  }
}

const credentialAssignmentPattern =
  /\b([A-Za-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|authorization)[A-Za-z0-9_.-]*)(\s*[:=]\s*)([^\s,;]+)/gi;
const bearerPattern = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const urlUserInfoPattern = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const knownTokenPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g;

export function redactBuildLogText(
  text: string,
  additionalRedactions: readonly string[] = [],
): string {
  let value = text
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(credentialAssignmentPattern, "$1$2[REDACTED]")
    .replace(bearerPattern, "$1[REDACTED]")
    .replace(urlUserInfoPattern, "$1[REDACTED]@")
    .replace(knownTokenPattern, "[REDACTED]");
  for (const secret of additionalRedactions) {
    if (secret.length > 0) {
      value = value.split(secret).join("[REDACTED]");
    }
  }
  return value;
}

function decodeProgressData(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 16_777_216 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new BuildProgressFormatError();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new BuildProgressFormatError();
  }
  return bytes.toString("utf8");
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value) <= maxBytes) {
    return value.length === 0 ? [] : [value];
  }
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (currentBytes + bytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuildProgressFormatError();
  }
  return value as Record<string, unknown>;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new BuildProgressFormatError();
  }
  return value.map(asRecord);
}

export interface BuildProgressConsumerOptions {
  readonly additionalRedactions?: readonly string[];
  readonly maxChunkBytes: number;
  readonly maxRetainedBytes: number;
  readonly sink: BuildLogSink;
}

export class BuildProgressConsumer {
  private readonly completedVertices = new Set<string>();
  private readonly cachedVertices = new Set<string>();
  private retainedBytes = 0;
  private truncated = false;

  public constructor(private readonly options: BuildProgressConsumerOptions) {
    if (
      !Number.isSafeInteger(options.maxChunkBytes) ||
      options.maxChunkBytes <= 0 ||
      !Number.isSafeInteger(options.maxRetainedBytes) ||
      options.maxRetainedBytes <= 0
    ) {
      throw new RangeError("Build log limits must be positive safe integers");
    }
  }

  public get cacheHitCount(): number {
    return this.cachedVertices.size;
  }

  public get cacheMissCount(): number {
    return this.completedVertices.size - this.cachedVertices.size;
  }

  private async emit(text: string, stream: BuildLogStream): Promise<void> {
    if (this.truncated) {
      return;
    }
    const redacted = redactBuildLogText(text, this.options.additionalRedactions);
    const chunks: BuildLogChunk[] = [];
    for (const content of splitUtf8(redacted, this.options.maxChunkBytes)) {
      const bytes = Buffer.byteLength(content);
      if (this.retainedBytes + bytes > this.options.maxRetainedBytes) {
        this.truncated = true;
        const notice = "\n[LaunchRail build log retention limit reached]\n";
        if (this.retainedBytes + Buffer.byteLength(notice) <= this.options.maxRetainedBytes) {
          chunks.push({ content: notice, stream: "system" });
          this.retainedBytes += Buffer.byteLength(notice);
        }
        break;
      }
      chunks.push({ content, stream });
      this.retainedBytes += bytes;
    }
    if (chunks.length > 0) {
      await this.options.sink.write(chunks);
    }
  }

  private trackVertex(vertex: Record<string, unknown>): void {
    const id = vertex.id ?? vertex.digest;
    if (typeof id !== "string" || id.length === 0 || id.length > 512) {
      throw new BuildProgressFormatError();
    }
    if (vertex.completed !== undefined || vertex.error !== undefined) {
      this.completedVertices.add(id);
      if (vertex.cached === true) {
        this.cachedVertices.add(id);
      }
    }
  }

  private async consumeLog(log: Record<string, unknown>): Promise<void> {
    const streamValue = log.stream;
    if (
      streamValue !== 1 &&
      streamValue !== 2 &&
      streamValue !== "stdout" &&
      streamValue !== "stderr"
    ) {
      throw new BuildProgressFormatError();
    }
    const stream: BuildLogStream =
      streamValue === 2 || streamValue === "stderr" ? "stderr" : "stdout";
    await this.emit(decodeProgressData(log.data), stream);
  }

  public async consumeLine(line: string, commandStream: "stderr" | "stdout"): Promise<void> {
    if (line.trim().length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      await this.emit(`${line}\n`, commandStream);
      return;
    }
    const status = asRecord(parsed);
    const vertexes = [...records(status.vertexes), ...records(status.vertices)];
    if (
      vertexes.length === 0 &&
      (status.id !== undefined || status.digest !== undefined) &&
      status.stream === undefined
    ) {
      this.trackVertex(status);
    } else {
      for (const vertex of vertexes) {
        this.trackVertex(vertex);
      }
    }
    const logs = records(status.logs);
    if (logs.length === 0 && status.stream !== undefined) {
      await this.consumeLog(status);
    } else {
      for (const log of logs) {
        await this.consumeLog(log);
      }
    }
    for (const warning of records(status.warnings)) {
      const detail = warning.detail;
      if (typeof detail === "string") {
        await this.emit(`${detail}\n`, "system");
      } else if (Array.isArray(detail)) {
        for (const item of detail) {
          if (typeof item !== "string") {
            throw new BuildProgressFormatError();
          }
          await this.emit(`${item}\n`, "system");
        }
      }
    }
  }
}
