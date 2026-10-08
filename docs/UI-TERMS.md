# UI terms (shared by Keepmark browser extension and Keepmark Android)

Both apps use the same words for the same things. Keep this file identical in
`KeepmarkApp/docs/UI-TERMS.md` and `KeepmarkMobile/docs/UI-TERMS.md`.

| Term | Meaning | Do not use |
|---|---|---|
| Service / Service URL | The xBrowserSync-compatible server the sync lives on | Server (as a label) |
| Sync, Sync ID | The encrypted bookmark collection on a service and its ID | sync id (lowercase) |
| Server copy | The encrypted data currently stored on the service | remote, remote side, remote tree |
| Local bookmarks / this device | The bookmarks in this browser or app | native bookmarks, local tree, local side |
| Item(s) | Bookmarks + folders + separators (counts) | nodes |
| Connect | Link this device to a new or existing sync | |
| New sync / Existing sync | The two connect modes | Use existing, … here |
| Unlink this device | Forget the credentials; local bookmarks stay | |
| **Download** | Replace the bookmarks on this device with the server copy | Take remote, Pull |
| **Upload** | Replace the server copy with the bookmarks on this device | Upload local, Upload mine, Overwrite remote, Push |
| **Merge** | Keep everything from both sides; nothing is deleted | union, never deletes |
| Sync conflict | The server copy changed since the last sync; user picks Download / Upload / Merge | |
| Move service / Move to another service | Wizard that moves the sync to another service (button: Move now, result: Move complete) | Switch service |
| Backup | Encrypted file export/import (button: Export encrypted backup, Choose backup file…, Replace local with backup) | |
| Safety backups | Automatic snapshots taken before every overwrite or deletion (newest 5 kept) | snapshot |
| Duplicates / Duplicate bookmarks | Same URL saved more than once; one copy of each URL always stays | address, link |

Confirmation buttons: `Yes, download` · `Yes, upload` · `Yes, merge` · `Yes, unlink` · `Yes, change password` · `Yes, restore` · `Yes, delete`, always with `Cancel`.
Workflow steps, buttons and implication lines: see `WORKFLOWS.md` (identical in both repos).
Busy labels: `Downloading…` · `Uploading…` · `Merging…`.
Password rule text: "at least 8 characters"; mismatch: "Passwords do not match."
Safety backup origins: `Downloaded server copy — Connect`, `Uploaded local bookmarks — Connect`,
`Downloaded server copy — Move service`, `Merged both sides — Move service`, … (see code tables).
