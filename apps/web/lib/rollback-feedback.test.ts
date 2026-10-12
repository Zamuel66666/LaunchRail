import { expect, it } from "vitest";
import { rollbackFailureFeedback } from "./rollback-feedback";
it("provides bounded actionable rollback guidance without exposing arbitrary metadata", () => {
  for (const code of [
    "rollback_unhealthy",
    "rollback_infrastructure_unavailable",
    "rollback_invalid_snapshot",
    "rollback_lease_exhausted",
  ])
    expect(rollbackFailureFeedback(code)).toContain("current release is retained");
  expect(rollbackFailureFeedback("rollback_state_conflict")).toContain(
    "Inspect the active release",
  );
  expect(rollbackFailureFeedback("CANARY_secret_exception")).not.toContain("CANARY");
});
