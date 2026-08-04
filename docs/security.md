# Security Model

Authentication uses short-lived access tokens, rotating refresh sessions, email verification, password reset, session revocation, and rate-limited auth endpoints. Authorization is enforced server-side for memberships, commissioner actions, platform roles, provider operations, and scoring corrections.

Secrets live in `.dev.vars` locally and Cloudflare Worker secrets in production. Never commit token signing keys, password peppers, VAPID private keys, Cloudflare credentials, session tokens, database exports, or user data. The PWA stores only bounded last-known league GET responses for offline read-only access; credentials and auth refresh responses are not cached.

API responses deny framing and MIME sniffing, disable unnecessary browser capabilities, send HSTS, and are never cached. Pages sends a restrictive CSP and long-lived caching only for hashed assets. Uploaded chat media is size/type checked and served with `nosniff`.

Administrator corrections require a reason, optimistic revision match, audit entry, notification, and reversible correction record. Production test-mode controls remain platform-role restricted and should be disabled outside an active test window.

Rotate any secret immediately if exposed, revoke affected sessions, inspect audit/login activity, and redeploy. See `docs/troubleshooting.md` for incident triage.
