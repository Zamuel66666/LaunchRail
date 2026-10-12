import type {
  RecordWebhookDeliveryCommand,
  WebhookDeliveryStore,
  WebhookDeliverySummary,
} from "@launchrail/application";
import type { GitHubPushEvent } from "@launchrail/application";
import { and, desc, eq, sql } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import { auditEvents, webhookDeliveries } from "./schema.js";

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  public constructor(private readonly db: LaunchRailDatabase) {}

  public async record(command: RecordWebhookDeliveryCommand): Promise<WebhookDeliverySummary> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
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
      let row =
        inserted ??
        (
          await tx
            .select()
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.organizationId, command.organizationId),
                eq(webhookDeliveries.provider, command.provider),
                eq(webhookDeliveries.deliveryId, command.deliveryId),
              ),
            )
            .for("update")
        )[0];
      if (row === undefined) throw new Error("Webhook delivery record disappeared");
      let recovered = false;
      if (
        inserted === undefined &&
        row.verificationState === "rejected" &&
        command.verificationState === "verified"
      ) {
        await tx.insert(auditEvents).values({
          organizationId: command.organizationId,
          action: "webhook.verification_recovered",
          targetType: "webhook_delivery",
          targetId: row.id,
          outcome: "succeeded",
          metadata: {
            previousVerificationState: row.verificationState,
            previousProcessingState: row.processingState,
            previousProcessingError: row.processingError,
            previousPayloadDigest: row.payloadDigest,
            previousEventName: row.eventName,
            previousReceivedAt: row.receivedAt.toISOString(),
          },
        });
        const [updated] = await tx
          .update(webhookDeliveries)
          .set({
            verificationState: "verified",
            processingState: "pending",
            processingError: null,
            processedAt: null,
            eventName: command.eventName,
            payloadDigest: command.payloadDigest,
            pushPayload: command.push === undefined ? null : { ...command.push },
            attemptCount: sql`least(${webhookDeliveries.attemptCount} + 1, 100)`,
          })
          .where(eq(webhookDeliveries.id, row.id))
          .returning();
        if (updated === undefined) throw new Error("Webhook delivery record disappeared");
        row = updated;
        recovered = true;
      }
      return {
        attemptCount: row.attemptCount,
        deliveryId: row.deliveryId,
        duplicate: inserted === undefined && !recovered,
        eventName: row.eventName,
        organizationId: row.organizationId,
        payloadDigest: row.payloadDigest,
        processingError: row.processingError,
        processingState: row.processingState,
        provider: row.provider,
        receivedAt: row.receivedAt,
        verificationState: row.verificationState,
      };
    });
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
    let [row] = await this.db
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
          ...(command.processingError === "invalid_signature" ||
          command.processingError === "invalid_payload"
            ? [eq(webhookDeliveries.verificationState, "rejected" as const)]
            : []),
        ),
      )
      .returning();
    if (
      row === undefined &&
      (command.processingError === "invalid_signature" ||
        command.processingError === "invalid_payload")
    ) {
      [row] = await this.db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.organizationId, command.organizationId),
            eq(webhookDeliveries.deliveryId, command.deliveryId),
          ),
        );
    }
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
