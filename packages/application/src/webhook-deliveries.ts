export interface RecordWebhookDeliveryCommand {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly organizationId: string;
  readonly payloadDigest: string;
  readonly provider: string;
  readonly verificationState: "rejected" | "verified";
}

export interface WebhookDeliverySummary extends RecordWebhookDeliveryCommand {
  readonly duplicate: boolean;
  readonly processingState: "failed" | "ignored" | "pending" | "processed";
  readonly receivedAt: Date;
}

export interface WebhookDeliveryStore {
  record(command: RecordWebhookDeliveryCommand): Promise<WebhookDeliverySummary>;
}

export interface WebhookDeploymentTrigger {
  trigger(event: {
    readonly deliveryId: string;
    readonly organizationId: string;
    readonly push: import("./webhooks.js").GitHubPushEvent;
  }): Promise<void>;
}
