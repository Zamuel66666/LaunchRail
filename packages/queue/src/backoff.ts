import { createHash } from "node:crypto";

import { createDeploymentClaimJobId } from "@launchrail/contracts";

export interface DeploymentClaimBackoffOptions {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly workItemId: string;
}

const jitterFloor = 0.75;
const maximumSafeExponent = 52;

function requirePositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/**
 * Returns a deterministic, capped exponential delay with 75-100% jitter.
 *
 * The stable work-item/attempt seed lets PostgreSQL reconciliation calculate
 * the same delay as BullMQ without persisting random queue-only state.
 */
export function computeDeploymentClaimBackoffMs({
  attempt,
  baseDelayMs,
  maxDelayMs,
  workItemId,
}: DeploymentClaimBackoffOptions): number {
  requirePositiveSafeInteger("attempt", attempt);
  requirePositiveSafeInteger("baseDelayMs", baseDelayMs);
  requirePositiveSafeInteger("maxDelayMs", maxDelayMs);
  if (baseDelayMs > maxDelayMs) {
    throw new RangeError("baseDelayMs cannot exceed maxDelayMs");
  }

  const jobId = createDeploymentClaimJobId(workItemId);
  const exponent = Math.min(attempt - 1, maximumSafeExponent);
  const exponentialDelay = baseDelayMs * 2 ** exponent;
  const cappedDelay = Math.min(
    maxDelayMs,
    Number.isSafeInteger(exponentialDelay) ? exponentialDelay : maxDelayMs,
  );
  const minimumDelay = Math.max(1, Math.ceil(cappedDelay * jitterFloor));
  const jitterSpan = cappedDelay - minimumDelay + 1;
  const sample = createHash("sha256").update(`${jobId}-${attempt}`).digest().readUInt32BE(0);

  return minimumDelay + Math.floor((sample / 0x1_0000_0000) * jitterSpan);
}
