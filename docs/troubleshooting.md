# Troubleshooting

## App Cannot Reach API

Check `https://api.myfflapp.com/health`, the Worker deployment, custom domain, and browser console correlation ID. Confirm the request origin is `https://app.myfflapp.com`; CORS intentionally rejects other production origins.

## Verification Email Missing

Confirm Cloudflare Email Sending remains enabled and DNS verified for `myfflapp.com`, the sender is `noreply@myfflapp.com`, and the Worker email binding is healthy. Check spam and Cloudflare email activity before resending.

## Provider or Scores Stale

Open myFFL Admin Monitoring and Provider Replay. Check queue backlog/dead letters, provider archives, event status, mapping gaps, scoring jobs, and data scope. Use replay to reproduce the ESPN-shaped sequence without modifying fixture semantics. Do not directly edit score tables.

## Desktop App Is Blank

Install or repair the Microsoft Edge WebView2 Evergreen Runtime, verify internet access, and restart the app. The client reports navigation failures in its status bar and can show previously cached read-only data after a successful prior load.

## Migration Failure

Stop the deployment, preserve the error and migration ledger, and do not rerun modified migration SQL under the same filename. Fix with a new forward migration, test locally, back up production, then apply it. Restore only when data is corrupted.

## Incident Checklist

Capture UTC time, correlation IDs, affected league/user/event IDs, Worker version, Pages deployment, active data scope, and recent admin audit entries. Revoke compromised sessions, disable test mode if involved, pause risky writes, preserve exports, and document all corrective actions.
