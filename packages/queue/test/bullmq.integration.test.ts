import { randomUUID } from "node:crypto";

import { createDeploymentClaimJobId, type DeploymentClaimJob } from "@launchrail/contracts";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BullMqDeploymentQueueConsumer,
  BullMqDeploymentQueuePublisher,
  InvalidDeploymentClaimJobError,
  type QueueInfrastructureEvent,
} from "../src/index.js";

const redisUrl = process.env.REDIS_URL;
const describeWithRedis = redisUrl === undefined ? describe.skip : describe;

function requireRedisUrl(): string {
  if (redisUrl === undefined) {
    throw new Error("REDIS_URL is required for Redis integration tests");
  }
  return redisUrl;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Redis queue state");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface RawQueueResource {
  readonly connection: Redis;
  readonly queue: Queue<unknown, unknown, string>;
}

describeWithRedis("BullMQ deployment claim queue", () => {
  let prefix: string;
  let queueName: string;
  let publishers: BullMqDeploymentQueuePublisher[];
  let consumers: BullMqDeploymentQueueConsumer[];
  let rawResources: RawQueueResource[];

  const queueOptions = () => ({
    prefix,
    queueName,
    redisUrl: requireRedisUrl(),
  });

  const createPublisher = (): BullMqDeploymentQueuePublisher => {
    const publisher = new BullMqDeploymentQueuePublisher(queueOptions());
    publishers.push(publisher);
    return publisher;
  };

  const createConsumer = (
    handler: ConstructorParameters<typeof BullMqDeploymentQueueConsumer>[0]["handler"],
    onInfrastructureEvent?: (event: QueueInfrastructureEvent) => void,
  ): BullMqDeploymentQueueConsumer => {
    const consumer = new BullMqDeploymentQueueConsumer({
      ...queueOptions(),
      handler,
      ...(onInfrastructureEvent === undefined ? {} : { onInfrastructureEvent }),
    });
    consumers.push(consumer);
    return consumer;
  };

  const createRawQueue = (): RawQueueResource => {
    const connection = new Redis(requireRedisUrl(), {
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => (attempt <= 1 ? 50 : null),
    });
    connection.on("error", () => undefined);
    const queue = new Queue<unknown, unknown, string>(queueName, { connection, prefix });
    queue.on("error", () => undefined);
    const resource = { connection, queue };
    rawResources.push(resource);
    return resource;
  };

  beforeEach(() => {
    const testId = randomUUID();
    prefix = `launchrail-test-${testId}`;
    queueName = `deployment-claims-${testId}`;
    publishers = [];
    consumers = [];
    rawResources = [];
  });

  afterEach(async () => {
    await Promise.allSettled(consumers.map((consumer) => consumer.close(true)));
    await Promise.allSettled(publishers.map((publisher) => publisher.close()));
    await Promise.allSettled(
      rawResources.map(async ({ connection, queue }) => {
        await queue.close();
        if (connection.status !== "end") {
          await connection.quit();
        }
      }),
    );

    const cleanupConnection = new Redis(requireRedisUrl(), { maxRetriesPerRequest: 1 });
    cleanupConnection.on("error", () => undefined);
    const cleanupQueue = new Queue(queueName, {
      connection: cleanupConnection,
      prefix,
    });
    cleanupQueue.on("error", () => undefined);
    try {
      await cleanupQueue.obliterate({ force: true });
    } finally {
      await cleanupQueue.close();
      if (cleanupConnection.status !== "end") {
        await cleanupConnection.quit();
      }
    }
  });

  it("coalesces concurrent duplicate enqueue around the stable contract job ID", async () => {
    const publisher = createPublisher();
    await publisher.waitUntilReady();
    const payload = {
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId: randomUUID(),
    } satisfies DeploymentClaimJob;

    const results = await Promise.all(Array.from({ length: 12 }, () => publisher.enqueue(payload)));

    expect(new Set(results.map(({ jobId }) => jobId))).toEqual(
      new Set([createDeploymentClaimJobId(payload.workItemId)]),
    );
    expect(await publisher.getState(payload.workItemId)).toBe("waiting");

    const { queue } = createRawQueue();
    const counts = await queue.getJobCounts("active", "completed", "delayed", "failed", "waiting");
    expect(
      (counts.active ?? 0) +
        (counts.completed ?? 0) +
        (counts.delayed ?? 0) +
        (counts.failed ?? 0) +
        (counts.waiting ?? 0),
    ).toBe(1);
  });

  it("validates and consumes one typed payload with an AbortSignal", async () => {
    const publisher = createPublisher();
    let received: DeploymentClaimJob | undefined;
    let receivedSignal: AbortSignal | undefined;
    const consumer = createConsumer(async (payload, signal) => {
      received = payload;
      receivedSignal = signal;
    });
    consumer.start();
    await Promise.all([publisher.waitUntilReady(), consumer.waitUntilReady()]);
    const payload = {
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId: randomUUID(),
    } satisfies DeploymentClaimJob;

    await publisher.enqueue(payload);
    await waitFor(() => received !== undefined);

    expect(received).toEqual(payload);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
    await waitFor(async () => (await publisher.getState(payload.workItemId)) === "absent");
  });

  it("allows PostgreSQL reconciliation to republish after failed and completed wake-ups", async () => {
    const publisher = createPublisher();
    let invocationCount = 0;
    const consumer = createConsumer(async () => {
      invocationCount += 1;
      if (invocationCount === 1) {
        throw new Error("untrusted-handler-detail");
      }
    });
    consumer.start();
    await Promise.all([publisher.waitUntilReady(), consumer.waitUntilReady()]);
    const payload = {
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId: randomUUID(),
    } satisfies DeploymentClaimJob;

    await publisher.enqueue(payload);
    await waitFor(() => invocationCount === 1);
    await waitFor(async () => (await publisher.getState(payload.workItemId)) === "absent");

    await publisher.enqueue(payload);
    await waitFor(() => invocationCount === 2);
    await waitFor(async () => (await publisher.getState(payload.workItemId)) === "absent");

    await publisher.enqueue(payload);
    await waitFor(() => invocationCount === 3);
    await waitFor(async () => (await publisher.getState(payload.workItemId)) === "absent");
  });

  it("replaces a retained malformed terminal wake-up with a valid stable-ID delivery", async () => {
    const publisher = createPublisher();
    const received: DeploymentClaimJob[] = [];
    const consumer = createConsumer(async (payload) => {
      received.push(payload);
    });
    consumer.start();
    await Promise.all([publisher.waitUntilReady(), consumer.waitUntilReady()]);

    const workItemId = randomUUID();
    const { queue } = createRawQueue();
    const malformed = await queue.add(
      "deployment.claim",
      {
        contractVersion: 1,
        kind: "deployment.claim",
        unexpected: "must-not-survive",
        workItemId,
      },
      { jobId: createDeploymentClaimJobId(workItemId) },
    );
    await waitFor(async () => (await malformed.getState()) === "failed");

    const valid = {
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId,
    } satisfies DeploymentClaimJob;
    await publisher.enqueue(valid);

    await waitFor(() => received.length === 1);
    expect(received).toEqual([valid]);
    await waitFor(async () => (await publisher.getState(workItemId)) === "absent");
  });

  it("rejects malformed and unknown jobs without invoking the typed handler or leaking input", async () => {
    const canary = "queue-canary-secret-do-not-echo";
    const infrastructureEvents: QueueInfrastructureEvent[] = [];
    let invocationCount = 0;
    const publisher = createPublisher();
    const consumer = createConsumer(
      async () => {
        invocationCount += 1;
      },
      (event) => infrastructureEvents.push(event),
    );
    consumer.start();
    await Promise.all([publisher.waitUntilReady(), consumer.waitUntilReady()]);

    let publisherError: unknown;
    try {
      await publisher.enqueue({
        contractVersion: 1,
        kind: "deployment.claim",
        secret: canary,
        workItemId: randomUUID(),
      });
    } catch (error) {
      publisherError = error;
    }
    expect(publisherError).toBeInstanceOf(InvalidDeploymentClaimJobError);
    expect(String(publisherError)).not.toContain(canary);

    const { queue } = createRawQueue();
    const malformed = await queue.add(
      "deployment.claim",
      {
        contractVersion: 1,
        kind: "deployment.claim",
        secret: canary,
        workItemId: randomUUID(),
      },
      { jobId: `malformed-${randomUUID()}` },
    );
    const unknown = await queue.add(
      "unknown.kind",
      {
        contractVersion: 1,
        kind: "deployment.claim",
        workItemId: randomUUID(),
      },
      { jobId: `unknown-${randomUUID()}` },
    );

    await waitFor(async () => (await malformed.getState()) === "failed");
    await waitFor(async () => (await unknown.getState()) === "failed");

    const failedMalformed = await queue.getJob(malformed.id as string);
    const failedUnknown = await queue.getJob(unknown.id as string);
    const safeOutput = JSON.stringify({
      infrastructureEvents,
      malformedFailure: failedMalformed?.failedReason,
      malformedStack: failedMalformed?.stacktrace,
      unknownFailure: failedUnknown?.failedReason,
      unknownStack: failedUnknown?.stacktrace,
    });
    expect(invocationCount).toBe(0);
    expect(failedMalformed?.failedReason).toBe("Invalid deployment claim job payload");
    expect(failedUnknown?.failedReason).toBe("Unsupported deployment queue job");
    expect(safeOutput).not.toContain(canary);
  });

  it("pauses, resumes, and closes without claiming later jobs", async () => {
    const publisher = createPublisher();
    let invocationCount = 0;
    const consumer = createConsumer(async () => {
      invocationCount += 1;
    });
    consumer.start();
    await Promise.all([publisher.waitUntilReady(), consumer.waitUntilReady()]);
    await consumer.pause();

    const first = {
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId: randomUUID(),
    } satisfies DeploymentClaimJob;
    await publisher.enqueue(first);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(invocationCount).toBe(0);
    expect(await publisher.getState(first.workItemId)).toBe("waiting");

    consumer.resume();
    await waitFor(() => invocationCount === 1);
    await consumer.close();

    const second = {
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId: randomUUID(),
    } satisfies DeploymentClaimJob;
    await publisher.enqueue(second);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(invocationCount).toBe(1);
    expect(await publisher.getState(second.workItemId)).toBe("waiting");
  });

  it("drains active work while leaving later wake-ups unclaimed", async () => {
    const publisher = createPublisher();
    let invocationCount = 0;
    let releaseHandler: (() => void) | undefined;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let markStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const consumer = createConsumer(async () => {
      invocationCount += 1;
      markStarted?.();
      await handlerReleased;
    });
    consumer.start();
    await Promise.all([publisher.waitUntilReady(), consumer.waitUntilReady()]);

    await publisher.enqueue({
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId: randomUUID(),
    });
    await handlerStarted;
    const drainPromise = consumer.drain();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const waiting = {
      contractVersion: 1,
      kind: "deployment.claim",
      workItemId: randomUUID(),
    } satisfies DeploymentClaimJob;
    await publisher.enqueue(waiting);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(invocationCount).toBe(1);

    releaseHandler?.();
    await drainPromise;
    expect(await publisher.getState(waiting.workItemId)).toBe("waiting");
  });
});
