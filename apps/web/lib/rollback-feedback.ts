export function rollbackFailureFeedback(errorCode: unknown): string {
  switch (errorCode) {
    case "rollback_unhealthy":
      return "The previous release failed its health check. The current release is retained. Inspect the previous release before retrying.";
    case "rollback_infrastructure_unavailable":
      return "The previous runtime could not be prepared. The current release is retained. Check Docker and the retained image, then retry.";
    case "rollback_invalid_snapshot":
      return "The previous release has missing or invalid saved configuration or image metadata. The current release is retained. Deploy a new release instead.";
    case "rollback_lease_exhausted":
      return "Rollback preparation was interrupted three times. The current release is retained. Check worker availability, then retry.";
    case "rollback_state_conflict":
      return "Release state changed during rollback. Inspect the active release before issuing another control.";
    default:
      return "Rollback did not complete. Inspect the recorded release state before retrying.";
  }
}
