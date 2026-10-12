import { expect, it } from "vitest";
import { deploymentPreviewUrl } from "./preview";

it("links only the serving deployment's exact localhost route, including rollback preparation", () => {
  const deploymentId = "11111111-1111-4111-8111-111111111111";
  const deployment = {
    deploymentId,
    state: "active",
    previewHostname: `d-${deploymentId}.localhost`,
  };
  expect(deploymentPreviewUrl(deployment)).toBe(`http://d-${deploymentId}.localhost:8080/`);
  expect(deploymentPreviewUrl({ ...deployment, state: "rolling_back" })).toBe(
    `http://d-${deploymentId}.localhost:8080/`,
  );
  for (const previewHostname of [
    "javascript:alert(1)",
    "example.com",
    "d-22222222-2222-4222-8222-222222222222.localhost",
    null,
  ])
    expect(deploymentPreviewUrl({ ...deployment, previewHostname })).toBeNull();
  expect(deploymentPreviewUrl({ ...deployment, state: "superseded" })).toBeNull();
});
