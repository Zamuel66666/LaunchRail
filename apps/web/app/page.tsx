import Link from "next/link";

const milestoneItems = [
  "Public GitHub references resolved and verified as exact commit and tree identities",
  "Shell-free, exact-SHA Git checkout isolated from ambient credentials and configuration",
  "Bounded source manifests with blob integrity, symlink containment, and LFS rejection",
  "Contained Dockerfile validation with portable immutable preparation metadata",
  "Restart-safe source jobs verified on disposable PostgreSQL and Redis services",
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
          Repository preparation verified on clean services
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
        <h2 id="milestone-title">Exact-source preparation is verified</h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Build prepared source safely</h2>
        <p>
          The next phase sends the verified checkout to a constrained BuildKit adapter, records an
          immutable image identity, streams bounded redacted logs, and proves failure, timeout,
          cancellation, cache, and cleanup behavior.
        </p>
      </section>
    </main>
  );
}
