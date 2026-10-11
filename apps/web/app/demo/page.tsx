import Link from "next/link";

const steps = [
  {
    title: "Create a project",
    detail:
      "Use a public GitHub repository and set its Dockerfile, health-check path, and container port.",
  },
  {
    title: "Deploy an exact revision",
    detail:
      "Paste a full commit SHA in the project workspace. LaunchRail records the immutable source snapshot before work is queued.",
  },
  {
    title: "Follow the release",
    detail:
      "Open the deployment timeline to inspect state changes, retained build output, health attempts, and a bounded runtime log tail.",
  },
  {
    title: "Promote safely",
    detail:
      "A candidate becomes active only after its configured health check passes. A failed candidate leaves the prior active release in place.",
  },
  {
    title: "Exercise operator controls",
    detail:
      "Review the recorded activity, then use the confirmation-protected stop, cancel, or rollback controls where the release state permits.",
  },
];

export default function DemoPage() {
  return (
    <main>
      <section className="hero" aria-labelledby="demo-title">
        <p className="eyebrow">Guided product walkthrough</p>
        <h1 id="demo-title">A release you can follow</h1>
        <p className="summary">
          This walkthrough uses your own self-hosted LaunchRail instance and a public GitHub
          repository. It does not create sample projects or deployments behind your back.
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/projects">
            Open project workspace <span aria-hidden="true">→</span>
          </Link>
          <Link className="secondary-link" href="/">
            Back to project status
          </Link>
        </div>
      </section>

      <section className="panel demo-panel" aria-labelledby="demo-prerequisites-title">
        <p className="section-label">Before you start</p>
        <h2 id="demo-prerequisites-title">A running local installation</h2>
        <p>
          Follow the clean setup in the development guide, create the first owner account, and sign
          in. The demo requires Docker, PostgreSQL, Redis, a configured Buildx builder, and a public
          repository with a runnable Dockerfile. Only use source you are authorized to build.
        </p>
        <Link href="/sign-in">Open sign-in</Link>
      </section>

      <section className="panel demo-panel" aria-labelledby="demo-steps-title">
        <p className="section-label">Walkthrough</p>
        <h2 id="demo-steps-title">From commit to healthy release</h2>
        <ol className="demo-steps">
          {steps.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <aside className="demo-boundary" aria-labelledby="demo-boundary-title">
        <h2 id="demo-boundary-title">What this demo does not claim</h2>
        <p>
          LaunchRail is not production-ready or a hostile multi-tenant build sandbox. Current limits
          include public GitHub sources only, a trusted single Docker host, and recovery paths that
          still need independent failure-injection verification. See the project roadmap before
          evaluating it for production.
        </p>
        <Link href="/">Review current project status</Link>
      </aside>
    </main>
  );
}
