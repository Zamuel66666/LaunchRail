import {
  createDeploymentJobId,
  parseDeploymentJob,
  type DeploymentJob,
} from "@launchrail/contracts";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";

export const deploymentQueueName = "launchrail-deployments";
export const deploymentQueuePrefix = "launchrail";

type SafeQueueComponent = "consumer" | "publisher";

export interface QueueInfrastructureEvent {
  readonly code: "redis_connection_error" | "queue_error";
  readonly component: SafeQueueComponent;
}

interface QueueLocationOptions {
  readonly prefix?: string;
  readonly queueName?: string;
  readonly redisUrl: string;
}

export interface DeploymentQueuePublisherOptions extends QueueLocationOptions {
  readonly onInfrastructureEvent?: (event: QueueInfrastructureEvent) => void;
}

export interface DeploymentQueueConsumerOptions extends QueueLocationOptions {
  readonly concurrency?: number;
  readonly handler: DeploymentJobHandler;
  readonly onInfrastructureEvent?: (event: QueueInfrastructureEvent) => void;
}

export interface DeploymentQueueEnqueueResult {
  readonly jobId: string;
}

export type DeploymentQueueJobState =
  | "absent"
  | "active"
  | "completed"
  | "delayed"
  | "failed"
  | "prioritized"
  | "unknown"
  | "waiting"
  | "waiting-children";

export type DeploymentJobHandler = (payload: DeploymentJob, signal: AbortSignal) => Promise<void>;

export class InvalidDeploymentJobError extends Error {
  public constructor() {
    super("Invalid deployment job payload");
    this.name = "InvalidDeploymentJobError";
  }
}

interface ResolvedQueueLocation {
  readonly prefix: string;
  readonly queueName: string;
  readonly redisUrl: string;
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireQueueIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new RangeError(`${name} must contain 1 to 128 letters, numbers, underscores, or hyphens`);
  }
  return value;
}

function resolveLocation(options: QueueLocationOptions): ResolvedQueueLocation {
  let redisUrl: URL;
  try {
    redisUrl = new URL(options.redisUrl);
  } catch {
    throw new RangeError("redisUrl must be a valid Redis URL");
  }
  if (redisUrl.protocol !== "redis:" && redisUrl.protocol !== "rediss:") {
    throw new RangeError("redisUrl must use the redis or rediss protocol");
  }

  return {
    prefix: requireQueueIdentifier("prefix", options.prefix ?? deploymentQueuePrefix),
    queueName: requireQueueIdentifier("queueName", options.queueName ?? deploymentQueueName),
    redisUrl: options.redisUrl,
  };
}

function safeInfrastructureNotifier(
  component: SafeQueueComponent,
  callback?: (event: QueueInfrastructureEvent) => void,
): (code: QueueInfrastructureEvent["code"]) => void {
  return (code) => {
    try {
      callback?.({ code, component });
    } catch {
      // Infrastructure reporting must not crash or mutate queue processing.
    }
  };
}

function createProducerConnection(
  redisUrl: string,
  notify: (code: QueueInfrastructureEvent["code"]) => void,
): Redis {
  const connection = new Redis(redisUrl, {
    commandTimeout: 3_000,
    connectTimeout: 3_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 3_000),
  });
  connection.on("error", () => notify("redis_connection_error"));
  return connection;
}

function createWorkerConnection(
  redisUrl: string,
  notify: (code: QueueInfrastructureEvent["code"]) => void,
): Redis {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", () => notify("redis_connection_error"));
  return connection;
}

async function closeOwnedConnection(connection: Redis): Promise<void> {
  if (connection.status === "end") {
    return;
  }
  try {
    await connection.quit();
  } catch {
    connection.disconnect(false);
  }
}

function parseQueuePayload(input: unknown): DeploymentJob {
  try {
    return parseDeploymentJob(input);
  } catch {
    throw new InvalidDeploymentJobError();
  }
}

export class BullMqDeploymentQueuePublisher {
  private readonly connection: Redis;
  private readonly queue: Queue<DeploymentJob, void, DeploymentJob["kind"]>;
  private closePromise: Promise<void> | undefined;

  public constructor(options: DeploymentQueuePublisherOptions) {
    const location = resolveLocation(options);
    const notify = safeInfrastructureNotifier("publisher", options.onInfrastructureEvent);
    this.connection = createProducerConnection(location.redisUrl, notify);
    this.queue = new Queue<DeploymentJob, void, DeploymentJob["kind"]>(location.queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
      prefix: location.prefix,
    });
    this.queue.on("error", () => notify("queue_error"));
  }

  public async waitUntilReady(): Promise<void> {
    await this.queue.waitUntilReady();
  }

  public async enqueue(input: unknown): Promise<DeploymentQueueEnqueueResult> {
    const payload = parseQueuePayload(input);
    const jobId = createDeploymentJobId(payload);
    await this.waitUntilReady();
    await this.removeTerminalWakeup(jobId);
    await this.queue.add(payload.kind, payload, { jobId });
    return { jobId };
  }

  private async removeTerminalWakeup(jobId: string): Promise<void> {
    const existing = await this.queue.getJob(jobId);
    if (existing === undefined) {
      return;
    }
    const state = await existing.getState();
    if (state !== "completed" && state !== "failed") {
      return;
    }

    try {
      await existing.remove();
    } catch (error) {
      const current = await this.queue.getJob(jobId);
      if (current === undefined) {
        return;
      }
      const currentState = await current.getState();
      if (currentState !== "completed" && currentState !== "failed") {
        return;
      }
      throw error;
    }
  }

  public async getState(
    workItemId: string,
    kind: DeploymentJob["kind"] = "deployment.claim",
  ): Promise<DeploymentQueueJobState> {
    await this.waitUntilReady();
    const job = await this.queue.getJob(createDeploymentJobId({ kind, workItemId }));
    if (job === undefined) {
      return "absent";
    }
    return job.getState();
  }

  public async remove(
    workItemId: string,
    kind: DeploymentJob["kind"] = "deployment.claim",
  ): Promise<boolean> {
    await this.waitUntilReady();
    const job = await this.queue.getJob(createDeploymentJobId({ kind, workItemId }));
    if (job === undefined) {
      return false;
    }
    await job.remove();
    return true;
  }

  public close(): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        await this.queue.close();
      } finally {
        await closeOwnedConnection(this.connection);
      }
    })();
    return this.closePromise;
  }
}

export class BullMqDeploymentQueueConsumer {
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly connection: Redis;
  private readonly notify: (code: QueueInfrastructureEvent["code"]) => void;
  private readonly worker: Worker<unknown, void, string>;
  private closePromise: Promise<void> | undefined;
  private runPromise: Promise<void> | undefined;

  public constructor(options: DeploymentQueueConsumerOptions) {
    const location = resolveLocation(options);
    const notify = safeInfrastructureNotifier("consumer", options.onInfrastructureEvent);
    this.notify = notify;
    const concurrency = requirePositiveSafeInteger("concurrency", options.concurrency ?? 1);
    this.connection = createWorkerConnection(location.redisUrl, notify);
    this.worker = new Worker<unknown, void, string>(
      location.queueName,
      async (job, _token, signal) => {
        const run = this.processJob(job.name, job.data, signal, options.handler);
        this.activeRuns.add(run);
        try {
          await run;
        } finally {
          this.activeRuns.delete(run);
        }
      },
      {
        autorun: false,
        connection: this.connection,
        concurrency,
        prefix: location.prefix,
      },
    );
    this.worker.on("error", () => notify("queue_error"));
  }

  /** Starts work after the application has registered its durable worker identity. */
  public start(): void {
    if (this.closePromise !== undefined) {
      throw new Error("Cannot start a closed deployment queue consumer");
    }
    this.runPromise ??= this.worker.run();
    void this.runPromise.catch(() => this.notify("queue_error"));
  }

  private async processJob(
    name: string,
    input: unknown,
    signal: AbortSignal | undefined,
    handler: DeploymentJobHandler,
  ): Promise<void> {
    if (name !== "deployment.claim" && name !== "deployment.prepare_source") {
      throw new UnrecoverableError("Unsupported deployment queue job");
    }

    let payload: DeploymentJob;
    try {
      payload = parseDeploymentJob(input);
    } catch {
      throw new UnrecoverableError("Invalid deployment job payload");
    }
    if (payload.kind !== name) {
      throw new UnrecoverableError("Deployment queue name and payload kind do not match");
    }

    const effectiveSignal = signal ?? new AbortController().signal;
    try {
      await handler(payload, effectiveSignal);
    } catch {
      throw new Error(
        effectiveSignal.aborted
          ? "Deployment job processing aborted"
          : "Deployment job handler failed",
      );
    }
  }

  public async waitUntilReady(): Promise<void> {
    await this.worker.waitUntilReady();
  }

  /** Stops new work after BullMQ's fetched and active jobs reach a safe pause point. */
  public async pause(): Promise<void> {
    await this.worker.pause();
  }

  /** Pauses new work and waits for handlers already running in this consumer. */
  public async drain(): Promise<void> {
    await this.pause();
    while (this.activeRuns.size > 0) {
      await Promise.allSettled([...this.activeRuns]);
    }
  }

  public resume(): void {
    this.worker.resume();
  }

  /** Aborts active handler signals; PostgreSQL leases remain authoritative for recovery. */
  public cancelActive(): void {
    this.worker.cancelAllJobs("Worker shutdown deadline reached");
  }

  public close(force = false): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        await this.worker.close(force);
      } finally {
        await closeOwnedConnection(this.connection);
      }
    })();
    return this.closePromise;
  }
}
