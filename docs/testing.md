# Testing and Release Gates

Every change must pass TypeScript type checking, all API unit and domain tests, the PWA production build, Worker dry run, and Windows Release build. GitHub Actions runs this matrix on pushes and pull requests.

Before production release, also complete these manual workflows:

- Register, verify email, sign in, refresh, sign out, forgot password, and reset password.
- Create and join a league; validate roster, scoring, schedule, and commissioner permissions.
- Run a draft through completion, submit a lineup, process waivers, and complete/reject a trade.
- Run provider test mode from pregame through final; verify stats, scoring components, matchup totals, standings, and notifications in the regular app.
- Apply and revert an administrator score correction and confirm audit entries.
- Disconnect the client after loading a league and verify cached read-only roster, matchup, standings, and schedule views.
- Check keyboard-only navigation, visible focus, labels, contrast, reduced motion, 200% zoom, and mobile/desktop layouts.

Test mode writes to an isolated data scope and must be disabled after replay validation. The production app should require no special awareness of replay data beyond the active provider scope selected by the backend.
