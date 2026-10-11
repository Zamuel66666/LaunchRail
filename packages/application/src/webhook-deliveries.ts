import type { GitHubPushEvent } from "./webhooks.js";

export interface RecordWebhookDeliveryCommand {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly organizationId: string;
  readonly payloadDigest: string;
  readonly provider: string;
  readonly verificationState: "rejected" | "verified";
  readonly push?: GitHubPushEvent;
}

export interface WebhookDeliverySummary extends Omit<RecordWebhookDeliveryCommand, "push"> {
  readonly duplicate: boolean;
  readonly attemptCount: number;
  readonly processingError: string | null;
  readonly processingState: "failed" | "ignored" | "pending" | "processed";
  readonly receivedAt: Date;
}

export interface WebhookDeliveryStore {
  record(command: RecordWebhookDeliveryCommand): Promise<WebhookDeliverySummary>;
  list(organizationId: string, limit: number): Promise<readonly WebhookDeliverySummary[]>;
  mark(command: {
    readonly deliveryId: string;
    readonly organizationId: string;
    readonly processingError?: string | null;
    readonly processingState: "failed" | "ignored" | "processed" | "pending";
    readonly retry?: boolean;
  }): Promise<WebhookDeliverySummary>;
  loadRetry(
    organizationId: string,
    deliveryId: string,
  ): Promise<{
    readonly deliveryId: string;
    readonly push: GitHubPushEvent;
  } | null>;
}

export interface WebhookDeploymentTrigger {
  trigger(event: {
    readonly deliveryId: string;
    readonly organizationId: string;
    readonly push: GitHubPushEvent;
    readonly traceHeaders?: {
      readonly traceparent?: string;
      readonly tracestate?: string;
    };
  }): Promise<void>;
}
