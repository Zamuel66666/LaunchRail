import Link from "next/link";

const milestoneItems = [
  "Opaque sessions with hashed server-side tokens and bounded lifetimes",
  "Owner, admin, developer, and viewer permission matrices",
  "Cross-organization concealment on every protected access path",
  "Origin validation, secure cookies, headers, and sign-in throttling",
  "Audited sign-in, sign-out, bootstrap, and membership changes",
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
          Authentication and authorization milestone available
        </div>
        <Link className="primary-link" href="/sign-in">
          Open secure sign-in <span aria-hidden="true">→</span>
        </Link>
      </section>

      <section className="panel" aria-labelledby="milestone-title">
        <p className="section-label">Current milestone</p>
        <h2 id="milestone-title">Organization data now has a security boundary</h2>
        <ul>
          {milestoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="next" aria-labelledby="next-title">
        <p className="section-label">Next milestone</p>
        <h2 id="next-title">Create and manage projects</h2>
        <p>
          The next phase adds organization-scoped project CRUD, repository configuration,
          environment metadata, and complete ownership tests at the API and database layers.
        </p>
      </section>
    </main>
  );
}
