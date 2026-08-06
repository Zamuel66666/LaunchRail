import type { Metadata } from "next";

import { ProjectWorkspace } from "../../components/project-workspace";

export const metadata: Metadata = {
  description: "Configure organization projects, runtime limits, and encrypted variables.",
  title: "Projects · LaunchRail",
};

export default function ProjectsPage() {
  return <ProjectWorkspace />;
}
