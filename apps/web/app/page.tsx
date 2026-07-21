const foundationItems = [
  "Typed web, API, worker, and shared-package workspace",
  "Independent health endpoints for every application",
  "Validated environment configuration with safe production guards",
  "Local PostgreSQL and Redis services",
  "Automated format, lint, type, test, and build checks",
];

export default function HomePage() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Self-hosted deployment orchestration</p>
        <h1 id="page-title">LaunchRail</h1>
        <p className="summary">
          LaunchRail will turn a GitHub repository into a health-checked container deployment with
          live logs, preview URLs, release history, and safe rollback.
        </p>
        <div className="status" role="status">
          <span className="status-dot" aria-hidden="true" />
          Repository foundation available
        </div>
      </section>

      <section className="panel" aria-labelledby="foundation-title">
        <p className="section-label">Current milestone</p>
        <h2 id="foundation-title">A dependable base for the deployment lifecycle</h2>
        <ul>
          {foundationItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Model projects and deployments</h2>
        <p>
          The next phase adds durable users, organizations, projects, deployment events, and the
          centrally validated state machine that keeps releases consistent.
        </p>
      </section>
    </main>
  );
}
