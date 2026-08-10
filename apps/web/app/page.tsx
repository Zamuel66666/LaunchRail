import Link from "next/link";

const milestoneItems = [
  "Identifier-only, runtime-validated deployment wake-up jobs",
  "PostgreSQL-authoritative attempts, leases, fencing, and dead letters",
  "At-least-once BullMQ delivery with bounded retry and timeout policy",
  "Worker heartbeats, reconciliation, and graceful draining",
  "Atomic queued-to-cloning claims and work-item completion under a fenced lease",
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
          Queue and worker foundation verified on clean services
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
        <h2 id="milestone-title">Background claim foundation is verified</h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Prepare repository source safely</h2>
        <p>
          The next phase resolves exact public GitHub revisions, performs bounded checkouts, records
          source metadata, and proves Dockerfile paths remain inside the repository.
        </p>
      </section>
    </main>
  );
}
