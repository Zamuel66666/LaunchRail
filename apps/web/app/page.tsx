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
  "Signed GitHub delivery outcomes, safe retry records, and webhook-trigger idempotency",
  "Bounded API, worker, queue, and health metrics with an optional local operations dashboard",
  "Manual deployment by exact Git commit and organization-scoped retained build-log viewing",
  "Organization-authorized runtime log tails via a private API-to-worker endpoint",
  "Lease-aware cleanup of orphaned runtimes and stale source/build staging directories",
  "Stale interrupted preview-route writes removed after a safe age threshold",
  "W3C trace propagation from API requests through BullMQ into worker spans",
  "Separate API database and worker startup readiness from process liveness",
  "Guided exact-revision demo walkthrough with explicit limitations",
  "Guarded end-to-end deployment benchmark script and a public-release checklist",
  "Reproducible API liveness benchmark output",
];

export default function HomePage() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Self-hosted deployment orchestration</p>
        <h1 id="page-title">LaunchRail</h1>
        <p className="summary">
          LaunchRail turns a GitHub repository into a health-checked container deployment with
          recent logs, preview URLs, release history, and safe rollback.
        </p>
        <div className="status" role="status">
          <span className="status-dot" aria-hidden="true" />
          Core deployment stages, trace propagation, dependency readiness, exact-SHA starts, and
          operator recovery are implemented; independent verification remains
        </div>
        <div className="hero-actions">
          <Link className="primary-link" href="/projects">
            Open project workspace <span aria-hidden="true">→</span>
          </Link>
          <Link className="secondary-link" href="/demo">
            Follow the demo walkthrough
          </Link>
          <Link className="secondary-link" href="/sign-in">
            Manage session
          </Link>
        </div>
      </section>

      <section className="panel" aria-labelledby="milestone-title">
        <p className="section-label">Current milestone</p>
        <h2 id="milestone-title">Current implementation status</h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Finish recovery, onboarding, and release evidence</h2>
        <p>
          Next: recover BuildKit daemon interruptions and remaining control races, complete an
          accessible first-run walkthrough, and add repeatable deployment benchmarks. Recent
          recovery and tracing additions still need independent validation; no release is claimed.
        </p>
      </section>
    </main>
  );
}
