import { deploymentJobStatuses, workerHeartbeatStatuses } from "@launchrail/application";
import { describe, expect, it } from "vitest";

import { schema } from "../src/index.js";

describe("deployment job schema contracts", () => {
  it("keeps durable status values aligned with the application port", () => {
    expect(schema.deploymentJobStatus.enumValues).toEqual(deploymentJobStatuses);
    expect(schema.workerHeartbeatStatus.enumValues).toEqual(workerHeartbeatStatuses);
  });
});
