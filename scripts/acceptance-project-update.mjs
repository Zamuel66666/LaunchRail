export function acceptanceProjectUpdate(project, changes) {
  const configuration = {
    name: project.name,
    repositoryUrl: project.repositoryUrl,
    defaultBranch: project.defaultBranch,
    dockerfilePath: project.dockerfilePath,
    healthCheckPath: project.healthCheckPath,
    healthCheckPort: project.healthCheckPort,
    runtimeConfig: project.runtimeConfig,
  };
  for (const key of Object.keys(changes)) {
    if (!Object.hasOwn(configuration, key))
      throw new Error("Unsupported acceptance project change");
    configuration[key] = changes[key];
  }
  return { ...configuration, expectedVersion: project.version };
}
