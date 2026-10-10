# Keepmark for browsers: Privacy Policy

Last updated: 11 October 2026

Keepmark is an open-source browser extension (Firefox, Chrome, Edge, Brave)
that syncs your bookmarks, end-to-end encrypted, through an
xBrowserSync-compatible sync service that you choose.

## Summary

- Keepmark does not collect, sell or share any personal data.
- There is no analytics, telemetry, advertising or tracking of any kind.
- Your bookmarks are encrypted in your browser before they leave your device.
- Keepmark never reads or modifies the web pages you visit.

## What leaves your device

Only when sync is enabled, Keepmark sends your bookmarks to the sync service
you selected (the official xBrowserSync service, a community host or your own
server). Before sending, your bookmarks are encrypted in the browser with
AES-GCM, using a key derived from your password with PBKDF2-SHA256.

The sync service therefore stores only:

- the encrypted bookmark data (ciphertext it cannot read),
- a random sync ID,
- timestamps and version information needed for sync.

Your password and your bookmarks in readable form are never sent anywhere.
The developer of Keepmark does not receive any of this data. The sync service
you choose is operated by its own provider (or by you), and its own privacy
policy applies.

## What stays on your device

Keepmark stores the following locally in your browser's extension storage:

- settings (for example the selected service URL and language),
- the sync ID and the key derived from your password (never the password
  itself),
- sync state and an activity log of recent sync events,
- up to 5 encrypted safety backups taken before destructive operations.

Backup files are created only when you export a backup, and are saved to your
device. Removing the extension deletes the local data.

## Permissions

Keepmark asks only for what sync needs: bookmarks, storage, alarms (periodic
check for changes), notifications (conflicts, removed sync), downloads
(backup export) and, on Chromium-based browsers, offscreen (theme detection
for the toolbar icon) and network access to reach the sync service you
choose. There are no content scripts and no remote code.

## Changes

Changes to this policy are published in this file, in the public repository
https://github.com/Keepmark/KeepmarkApp.

## Contact

keepmark@proton.me
