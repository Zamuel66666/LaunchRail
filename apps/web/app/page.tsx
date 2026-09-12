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
          Source preparation, image builds, and restricted runtimes verified on clean services
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
          Exact source preparation, image builds, and runtimes are verified
        </h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Route and health-check the candidate runtime</h2>
        <p>
          The next phase registers the restricted loopback runtime behind a preview URL and promotes
          it only after an explicit HTTP health check succeeds.
        </p>
      </section>
    </main>
  );
}
