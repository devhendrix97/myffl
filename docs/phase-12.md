# Phase 12 - Native Clients and Production Release

The Windows member app now embeds the production myFFL workspace through WebView2, preserving one backend and account while adding native navigation, history, refresh, keyboard shortcuts, report printing/export, connection state, and a dockable live matchup panel. The PWA supports deep links and bounded last-known-data fallback with explicit offline read-only behavior.

Release engineering includes GitHub Actions for web/API and Windows builds, API and Pages security headers, version `1.0.0`, deployment and recovery runbooks, a complete release test checklist, and production smoke checks.
