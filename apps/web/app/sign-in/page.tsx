"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { ApiError, getSession, signIn, signOut, type SessionUser } from "../../lib/api";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<"checking" | "idle" | "submitting">("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    void getSession(controller.signal)
      .then((sessionUser) => setUser(sessionUser))
      .catch((error: unknown) => {
        if (!controller.signal.aborted && (!(error instanceof ApiError) || error.status !== 401)) {
          setMessage("LaunchRail API is unavailable. Check the local services and try again.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatus("idle");
      });

    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage("");
    setStatus("submitting");

    try {
      const sessionUser = await signIn(email, password);
      setPassword("");
      setUser(sessionUser);
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : "LaunchRail API is unavailable. Check the local services and try again.",
      );
    } finally {
      setStatus("idle");
    }
  }

  async function endSession(): Promise<void> {
    setMessage("");
    setStatus("submitting");

    try {
      await signOut();
      setUser(null);
      setEmail("");
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : "LaunchRail API is unavailable. Check the local services and try again.",
      );
    } finally {
      setStatus("idle");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-context" aria-labelledby="auth-title">
        <Link className="wordmark" href="/">
          LaunchRail
        </Link>
        <p className="eyebrow">Protected control plane</p>
        <h1 id="auth-title">Deployments stay inside your organization.</h1>
        <p className="summary">
          Sessions are opaque, time-bounded, and stored as hashes. Every organization route checks
          the signed-in member’s role before returning data.
        </p>
        <div className="security-strip" aria-label="Security controls">
          <span>HttpOnly cookie</span>
          <span>Origin checks</span>
          <span>Role policy</span>
        </div>
      </section>

      <section className="auth-card" aria-live="polite">
        {status === "checking" ? (
          <div className="session-check">
            <span className="status-dot" aria-hidden="true" />
            Checking your session…
          </div>
        ) : user === null ? (
          <>
            <div className="auth-heading">
              <p className="section-label">Member access</p>
              <h2>Sign in to LaunchRail</h2>
              <p>Use the owner account created with the bootstrap command.</p>
            </div>
            <form onSubmit={(event) => void submit(event)}>
              <label htmlFor="email">Email address</label>
              <input
                autoComplete="email"
                id="email"
                maxLength={320}
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
              <label htmlFor="password">Password</label>
              <input
                autoComplete="current-password"
                id="password"
                minLength={12}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
              {message.length > 0 ? <p className="form-message error-message">{message}</p> : null}
              <button disabled={status === "submitting"} type="submit">
                {status === "submitting" ? "Signing in…" : "Sign in securely"}
              </button>
            </form>
          </>
        ) : (
          <div className="signed-in">
            <p className="section-label">Session active</p>
            <h2>Welcome, {user.displayName}</h2>
            <p className="signed-in-email">{user.email}</p>
            <div className="membership-list">
              {user.memberships.map((membership) => (
                <article key={membership.organizationId}>
                  <div>
                    <h3>{membership.organizationName}</h3>
                    <p>{membership.organizationSlug}</p>
                  </div>
                  <span className={`role role-${membership.role}`}>{membership.role}</span>
                </article>
              ))}
            </div>
            {user.memberships.length === 0 ? (
              <p className="form-message">This account has no organization memberships.</p>
            ) : null}
            {message.length > 0 ? <p className="form-message error-message">{message}</p> : null}
            {user.memberships.length > 0 ? (
              <Link className="primary-link workspace-link" href="/projects">
                Open project workspace <span aria-hidden="true">→</span>
              </Link>
            ) : null}
            <button
              className="button-secondary"
              disabled={status === "submitting"}
              onClick={() => void endSession()}
              type="button"
            >
              {status === "submitting" ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
