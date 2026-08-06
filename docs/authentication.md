# Authentication and authorization

## Scope

Phase 3 adds the first enforceable browser-to-organization security boundary. LaunchRail supports a locally bootstrapped owner, password sign-in, opaque server-side sessions, organization roles, membership management, and identity audit history. This is suitable for a trusted local demonstration, not public production hosting.

## Bootstrap the first owner

Apply migrations, then set the bootstrap values in the root `.env`:

```dotenv
LAUNCHRAIL_BOOTSTRAP_EMAIL=owner@example.test
LAUNCHRAIL_BOOTSTRAP_DISPLAY_NAME=Local Owner
LAUNCHRAIL_BOOTSTRAP_ORGANIZATION_NAME=Example Organization
LAUNCHRAIL_BOOTSTRAP_ORGANIZATION_SLUG=example-org
LAUNCHRAIL_BOOTSTRAP_PASSWORD=replace-with-a-long-local-password
```

Run:

```bash
pnpm db:migrate
pnpm auth:bootstrap
```

Bootstrap succeeds only when no user or organization exists. The command prints the created email and organization slug but never the password or credential hash. Remove the bootstrap password from `.env` after the command succeeds.

## Credential and session model

- Passwords use Node.js `scrypt` with a unique random salt. The encoded parameter set is stored separately from the user profile.
- Successful sign-in creates a 256-bit random opaque token. PostgreSQL stores only its SHA-256 hash.
- Sessions have a fixed absolute expiry and rolling idle expiry. Expired, revoked, or disabled-user sessions fail closed.
- Sign-out revokes the server-side record and clears the browser cookie.
- Browser cookies are `HttpOnly`, `SameSite=Strict`, scoped to `/`, and `Secure` in production.
- Production configuration requires an HTTPS `WEB_ORIGIN`.

The relevant API configuration is:

| Variable                     | Default                 | Constraint                                  |
| ---------------------------- | ----------------------- | ------------------------------------------- |
| `WEB_ORIGIN`                 | `http://localhost:3000` | Exact browser origin; HTTPS in production   |
| `SESSION_COOKIE_NAME`        | `launchrail_session`    | Letters, numbers, underscores, and hyphens  |
| `SESSION_IDLE_TTL_MINUTES`   | `30`                    | Positive and no longer than absolute expiry |
| `SESSION_ABSOLUTE_TTL_HOURS` | `24`                    | Positive, at most 168 hours                 |
| `SIGN_IN_RATE_LIMIT_MAX`     | `5`                     | Attempts per client per minute              |

## Organization roles

Authorization is deny-by-default. A session receives current memberships on every authenticated request, so role changes take effect without issuing a new session.

| Permission             | Owner | Admin | Developer | Viewer |
| ---------------------- | :---: | :---: | :-------: | :----: |
| Read organization      |   ✓   |   ✓   |     ✓     |   ✓    |
| Manage organization    |   ✓   |       |           |        |
| Read projects          |   ✓   |   ✓   |     ✓     |   ✓    |
| Create projects        |   ✓   |   ✓   |     ✓     |        |
| Create/control deploys |   ✓   |   ✓   |     ✓     |        |
| Read memberships       |   ✓   |   ✓   |           |        |
| Manage memberships     |   ✓   |   ✓   |           |        |
| Read audit history     |   ✓   |   ✓   |           |        |

Owners may assign any role. Administrators may move only developers and viewers between those two roles. The final owner cannot be demoted.

## HTTP boundary

| Method  | Route                                               | Access                          |
| ------- | --------------------------------------------------- | ------------------------------- |
| `POST`  | `/v1/auth/sign-in`                                  | Public, origin and rate checked |
| `POST`  | `/v1/auth/sign-out`                                 | Origin checked                  |
| `GET`   | `/v1/auth/session`                                  | Authenticated                   |
| `GET`   | `/v1/organizations`                                 | Authenticated                   |
| `GET`   | `/v1/organizations/:organizationId`                 | Organization reader             |
| `GET`   | `/v1/organizations/:organizationId/members`         | Owner or admin                  |
| `PATCH` | `/v1/organizations/:organizationId/members/:userId` | Owner or admin, role rules      |
| `GET`   | `/v1/organizations/:organizationId/audit-events`    | Owner or admin                  |

Every mutation under `/v1` requires an `Origin` header exactly equal to `WEB_ORIGIN`. CORS allows credentials only for that origin. Fastify also applies bounded request bodies, schema validation, security headers, and per-client sign-in throttling.

Unauthenticated requests return `401`; known organizations without sufficient role return `403`; organization IDs outside the principal's memberships return `404` so the boundary does not reveal their existence. Credential failures use one generic response. Unexpected adapter errors remain `500` and never expose database text.

## Audit evidence

LaunchRail records successful bootstrap, successful and rejected sign-in, sign-out, and membership role changes. Audit rows include organization, actor, action, target, outcome, timestamp, and non-secret metadata.

The real-PostgreSQL API suite verifies token hashing, cookie policy, revocation, generic credential rejection, rate limiting, origin enforcement, role permissions, privileged-role protection, last-owner protection, audit insertion, and every protected cross-organization access path for all four roles.

## Current limitations

There is no password reset, invitation flow, email verification, MFA, SSO, credential rotation UI, global session list, or remote session termination. The bootstrap command is intentionally one-time and local. TLS termination and secure deployment configuration remain operator responsibilities. Project and deployment authorization will reuse this policy boundary as those APIs are added.
