import Link from "next/link";

const milestoneItems = [
  "Public GitHub references resolved and verified as exact commit and tree identities",
  "Shell-free, exact-SHA Git checkout isolated from ambient credentials and configuration",
  "Bounded source manifests with blob integrity, symlink containment, and LFS rejection",
  "Contained Dockerfile validation with portable immutable preparation metadata",
  "Restart-safe source jobs verified on disposable PostgreSQL and Redis services",
  "Private BuildKit contexts sealed against source changes before image construction",
  "Immutable local image records and bounded redacted build logs",
  "Pinned BuildKit acceptance tests for build success, failure, cache, timeout, cancellation, and cleanup",
  "Restricted Docker runtimes with loopback-only ports, least privilege, resource bounds, logs, and idempotent adoption",
  "Bounded HTTP health checks with durable attempt history and atomic promotion",
  "Organization-scoped deployment events with idempotent promote, cancel, stop, and rollback controls",
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
          Health-checked deployments, durable history, and release controls verified on clean
          services
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
        <h2 id="milestone-title">
          Health-checked releases and safe deployment controls are verified
        </h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Complete retry orchestration and operator timeline</h2>
        <p>
          The next phase adds safe retry creation, runtime reconciliation after stop and rollback,
          and a recruiter-readable deployment timeline backed by the event history API.
        </p>
      </section>
    </main>
  );
}
