import type {
  RecordWebhookDeliveryCommand,
  WebhookDeliveryStore,
  WebhookDeliverySummary,
} from "@launchrail/application";
import { and, eq } from "drizzle-orm";

import type { LaunchRailDatabase } from "./client.js";
import { webhookDeliveries } from "./schema.js";

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  public constructor(private readonly db: LaunchRailDatabase) {}

  public async record(command: RecordWebhookDeliveryCommand): Promise<WebhookDeliverySummary> {
    const [inserted] = await this.db
      .insert(webhookDeliveries)
      .values(command)
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
      deliveryId: row.deliveryId,
      duplicate: inserted === undefined,
      eventName: row.eventName,
      organizationId: row.organizationId,
      payloadDigest: row.payloadDigest,
      processingState: row.processingState,
      provider: row.provider,
      receivedAt: row.receivedAt,
      verificationState: row.verificationState,
    };
  }
}
