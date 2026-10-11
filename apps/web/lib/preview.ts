export function deploymentPreviewUrl(deployment: {
  readonly deploymentId: string;
  readonly state: string;
  readonly previewHostname?: string | null;
}): string | null {
  if (
    deployment.state !== "active" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      deployment.deploymentId,
    ) ||
    deployment.previewHostname !== `d-${deployment.deploymentId}.localhost`
  )
    return null;
  const port = Number(process.env.NEXT_PUBLIC_PREVIEW_PORT ?? "8080");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return `http://${deployment.previewHostname}:${port}/`;
}
