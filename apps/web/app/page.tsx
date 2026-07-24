const milestoneItems = [
  "Organization-scoped users, memberships, projects, and deployments",
  "Fourteen-state deployment lifecycle validated in one domain module",
  "Transactional state changes, ordered events, and audit records",
  "Idempotent commands and health-gated active-release promotion",
  "Generated migrations verified against disposable PostgreSQL in CI",
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
          Domain and persistence milestone available
        </div>
      </section>

      <section className="panel" aria-labelledby="milestone-title">
        <p className="section-label">Current milestone</p>
        <h2 id="milestone-title">Deployment truth now survives process restarts</h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Secure access to organization data</h2>
        <p>
          The next phase adds sign-in, secure sessions, membership-based authorization, request
          hardening, and negative tests for every cross-organization access path.
        </p>
      </section>
    </main>
  );
}
