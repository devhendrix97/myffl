# Phase 10: Communication and Notifications

Phase 10 adds the league conversation, audit, weekly storytelling, and delivery systems around the core fantasy-football experience.

## Available

- League and draft chat channels with replies, mentions, reactions, soft deletion, read indicators, and commissioner pins
- Commissioner announcements, image uploads, approved Giphy media, and single- or multiple-choice polls
- Authenticated R2 media access with file-type and five-megabyte size limits
- Immutable league activity for membership, draft, transaction, scoring, correction, matchup, and playoff events
- Persisted weekly reports for high and low scores, closest matchup, blowout, bench points, efficiency, comebacks, unlucky results, free agents, and power rankings
- A global notification center with unread counts, read state, action links, polling, and native desktop alerts
- Per-league, per-event preferences for in-app, browser push, email, and future SMS channels
- Queue-backed, idempotent notification delivery so application writes are not blocked by provider latency
- VAPID-encrypted browser push with dead-subscription cleanup and a service worker that opens the relevant app view
- Installable PWA metadata and branded app/notification icons

## Test Flow

1. Open a league and select **Community**.
2. Send messages in both league and draft channels, then reply, react, mention another manager, and mark a message as read.
3. Upload an image, add a Giphy URL, create a poll, vote, and pin a commissioner announcement.
4. Open **Activity** and confirm draft, roster, transaction, and scoring actions appear without edit controls.
5. Open **Weekly report**, select a completed week, and inspect the matchup highlights and power rankings.
6. Open notification preferences, enable browser push, and allow the browser permission prompt.
7. Trigger a configured event and confirm it appears once in the notification center and through each enabled delivery channel.
8. Install the app from the browser and verify the branded icon, offline shell, and notification-click navigation.

Browser push uses the standard Web Push protocol and does not expose the private VAPID key to clients. Production and replay events use the same notification pipeline.
