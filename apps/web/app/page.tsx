import Link from "next/link";

const milestoneItems = [
  "Organization-scoped project creation, editing, and archival",
  "Canonical GitHub HTTPS repository and checkout-safe path validation",
  "Bounded health-check and runtime resource configuration",
  "Encrypted, write-only environment-variable management",
  "Permission-aware controls with explicit async and empty states",
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
          Project management milestone available
        </div>
        <div className="hero-actions">
          <Link className="primary-link" href="/projects">
            Open project workspace <span aria-hidden="true">→</span>
          </Link>
          <Link className="secondary-link" href="/sign-in">
            Manage session
          </Link>
        </div>
      </section>

      <section className="panel" aria-labelledby="milestone-title">
        <p className="section-label">Current milestone</p>
        <h2 id="milestone-title">Projects can be configured without leaking secrets</h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Queue reliable background work</h2>
        <p>
          The next phase adds typed deployment jobs, retry and timeout policy, dead-letter handling,
          worker heartbeats, and restart-safe reconciliation entry points.
        </p>
      </section>
    </main>
  );
}
