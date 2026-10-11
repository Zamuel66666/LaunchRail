import type {
  RecordWebhookDeliveryCommand,
  WebhookDeliveryStore,
  WebhookDeliverySummary,
} from "@launchrail/application";
import type { GitHubPushEvent } from "@launchrail/application";
import { and, desc, eq, sql } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import { webhookDeliveries } from "./schema.js";

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  public constructor(private readonly db: LaunchRailDatabase) {}

  public async record(command: RecordWebhookDeliveryCommand): Promise<WebhookDeliverySummary> {
    const [inserted] = await this.db
      .insert(webhookDeliveries)
      .values({
        deliveryId: command.deliveryId,
        eventName: command.eventName,
        organizationId: command.organizationId,
        payloadDigest: command.payloadDigest,
        attemptCount: 1,
        processingState: "pending",
        provider: command.provider,
        pushPayload: command.push === undefined ? null : { ...command.push },
        verificationState: command.verificationState,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted ??
      (
        await this.db
          .select()
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.organizationId, command.organizationId),
              eq(webhookDeliveries.provider, command.provider),
              eq(webhookDeliveries.deliveryId, command.deliveryId),
            ),
          )
      )[0];
    if (row === undefined) throw new Error("Webhook delivery record disappeared");
    return {
      attemptCount: row.attemptCount,
      deliveryId: row.deliveryId,
      duplicate: inserted === undefined,
      eventName: row.eventName,
      organizationId: row.organizationId,
      payloadDigest: row.payloadDigest,
      processingError: row.processingError,
      processingState: row.processingState,
      provider: row.provider,
      receivedAt: row.receivedAt,
      verificationState: row.verificationState,
    };
  }

  public async list(
    organizationId: string,
    limit: number,
  ): Promise<readonly WebhookDeliverySummary[]> {
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.organizationId, organizationId))
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(limit);
    return rows.map((row) => ({
      attemptCount: row.attemptCount,
      deliveryId: row.deliveryId,
      duplicate: false,
      eventName: row.eventName,
      organizationId: row.organizationId,
      payloadDigest: row.payloadDigest,
      processingError: row.processingError,
      processingState: row.processingState,
      provider: row.provider,
      receivedAt: row.receivedAt,
      verificationState: row.verificationState,
    }));
  }

  public async mark(command: {
    readonly deliveryId: string;
    readonly organizationId: string;
    readonly processingError?: string | null;
    readonly processingState: "failed" | "ignored" | "processed" | "pending";
    readonly retry?: boolean;
  }): Promise<WebhookDeliverySummary> {
    const [row] = await this.db
      .update(webhookDeliveries)
      .set({
        ...(command.retry ? { attemptCount: sql`${webhookDeliveries.attemptCount} + 1` } : {}),
        processedAt: command.processingState === "pending" ? null : sql`clock_timestamp()`,
        processingError: command.processingError ?? null,
        processingState: command.processingState,
      })
      .where(
        and(
          eq(webhookDeliveries.organizationId, command.organizationId),
          eq(webhookDeliveries.deliveryId, command.deliveryId),
          ...(command.retry ? [eq(webhookDeliveries.processingState, "failed" as const)] : []),
        ),
      )
      .returning();
    if (row === undefined) throw new Error("Webhook delivery is not retryable or was not found");
    return {
      attemptCount: row.attemptCount,
      deliveryId: row.deliveryId,
      duplicate: false,
      eventName: row.eventName,
      organizationId: row.organizationId,
      payloadDigest: row.payloadDigest,
      processingError: row.processingError,
      processingState: row.processingState,
      provider: row.provider,
      receivedAt: row.receivedAt,
      verificationState: row.verificationState,
    };
  }

  public async loadRetry(
    organizationId: string,
    deliveryId: string,
  ): Promise<{ readonly deliveryId: string; readonly push: GitHubPushEvent } | null> {
    const [row] = await this.db
      .select({
        deliveryId: webhookDeliveries.deliveryId,
        processingState: webhookDeliveries.processingState,
        pushPayload: webhookDeliveries.pushPayload,
        verificationState: webhookDeliveries.verificationState,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.organizationId, organizationId),
          eq(webhookDeliveries.deliveryId, deliveryId),
        ),
      );
    if (
      row === undefined ||
      row.verificationState !== "verified" ||
      row.processingState !== "failed" ||
      !isGitHubPushEvent(row.pushPayload)
    )
      return null;
    return { deliveryId: row.deliveryId, push: row.pushPayload };
  }
}

function isGitHubPushEvent(value: unknown): value is GitHubPushEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.branch === "string" &&
    typeof candidate.repositoryName === "string" &&
    typeof candidate.repositoryOwner === "string" &&
    typeof candidate.revision === "string" &&
    /^[0-9a-f]{40}$/.test(candidate.revision)
  );
}
