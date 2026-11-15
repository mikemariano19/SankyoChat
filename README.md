# Sankyo Chat

A team chat app made of plain HTML, CSS and JavaScript. It runs with no internet and no server: you copy the folder to the office shared drive, and the shared `data` folder carries messages between PCs.

**Requirements:** Microsoft Edge or Google Chrome, version 110 or newer. Nothing gets installed.

## Deploying

1. Copy this whole `SankyoChat` folder to the share, for example `\\fileserver\Shared\SankyoChat\`.
2. Permissions:
   - App files (`index.html`, `check.html`, `css`, `js`, `assets`): **read-only** for staff. Only you or IT can change them. Anyone who can edit the code could make it capture passwords.
   - `data` folder: **Modify** for the staff group only.
3. Turn on Previous Versions (shadow copies) for the share, or copy `data` daily. A copy of `data` is a full backup, and DMs stay encrypted in it.
4. Give staff a desktop shortcut to `\\fileserver\Shared\SankyoChat\index.html`, set to open in Edge or Chrome.
5. **Open the app yourself first.** The first person to connect an empty `data` folder creates the workspace and becomes the **super admin**. Remember your password: nobody can reset the super admin's password. Appoint admins later in ⚙ → Admin settings → People → **Make admin**.
6. Optional: in the app, open ⚙ → Admin settings → App files → **Check app files**, pick the `SankyoChat` folder, and click **Save as trusted fingerprint**. Later you can re-check whether anyone changed the code.

When a PC has problems, open `check.html`. It tests the browser, folder access (it writes, reads and deletes a small file), encryption and notifications.

### Updating

Copy the new files over the app folder and raise `APP_VERSION` in `js/version.js`. Within 5 minutes, running apps show "A new version is available. Reload". Never copy anything over `data`.

## How it works

| File | Role |
| --- | --- |
| `js/store.js` | The only module that touches the shared folder (File System Access API) |
| `js/crypto.js` | Web Crypto: ECDSA P-256 signatures, ECDH P-256 + HKDF, AES-GCM 256, PBKDF2-SHA256 at 600,000 rounds |
| `js/account.js` | Workspace, profiles, sign-in, admin actions, feedback inbox |
| `js/sync.js` | Channels, messages, polling, presence, 7-day DM retention, search, export |
| `js/ui.js` | DOM helpers, dialogs, message formatting, setup screens |
| `js/chat.js` | Main chat view and in-chat dialogs |
| `js/app.js` | Start-up, routing, theme, notifications, idle and auto-lock, update check |
| `js/emoji.js` | Bundled emoji list |
| `js/check.js` | The compatibility check page |

- **Every write creates a new file** (`channels/<id>/<UTC day>/<ts>_<user>_<rand>.json`). No two people ever write the same file. Edits, deletes and reactions are separate signed event files (`*.ev.json`).
- **Polling:** the open conversation is listed every 2 s. Every 5 s the app reads each person's small `presence/<id>.json` file, whose `lastPost` map shows which conversations changed, and then lists only those. A heartbeat is written every 10 s. Polling pauses when the window has been hidden for 5 minutes.
- **Signatures:** every message, event, profile, channel and `workspace.json` is signed. Messages that fail the check are hidden behind "Unverified sender". Forged edits and reactions are ignored.
- **DMs and group DMs:** text, mentions, replies and attachments (including file names) are encrypted. 1:1 keys come from ECDH between the two people. A group DM uses a random key, wrapped once for each member. Expired DM files and their attachments are deleted hourly by members, and by the admin's app for every DM.
- **Keys** are encrypted with your password and stored in `users/<id>.keys.json`. Passwords are never stored. "Keep me signed in" keeps non-extractable keys in this browser only.
- **Kept on each PC only:** the folder permission, last-read positions, theme and sound settings, and a cache of channel messages (files never change once written, so caching them is safe).

## Where it differs from the requirements doc

- **Classic scripts, not ES modules.** Edge and Chrome refuse to load `type="module"` scripts from `file://` pages, so every file attaches to one global `SC` namespace instead. There is still no build step.
- **"Keep me signed in" turns off auto-lock on that PC.** Otherwise the checkbox would do nothing, because auto-lock would sign people out anyway. The checkbox says to use it only on a PC nobody else uses. The admin sets the auto-lock time (default 30 minutes; "Never" is allowed).
- **Super admin and admins** (the requirements doc had one admin). The workspace creator is the **super admin**. Only they can appoint or remove admins, change workspace settings, check the app files, and read the feedback inbox, which is encrypted to their key alone. **Admins** can create, rename and archive channels, hide channel messages, and reset passwords or remove regular staff. They can never touch the super admin or other admins, and nobody can read DMs.
  - The admin list lives in `workspace.json`, which only the super admin's key can sign.
  - Each admin action is its own file in `data/admin/`, signed by the admin who took it. Every app checks the signer against that list and ignores anything else.
  - When an admin is removed, actions they took while they were admin stay in effect. Admin settings → Activity shows who did what.
- **Only admins can create channels** (FR-05 said anyone could). Everyone else's app hides the "+" button, and every app ignores channel folders on the share unless an admin signed them. Everyone can still start direct messages, and anyone can create a named **group chat** (sidebar → Group chats → +) with up to 20 people. Group chats are encrypted like DMs, including their name, and follow the same 7-day retention. The creator can rename the group, add people and remove people later (Details → Rename / Add people / Remove). Removing someone gives the group a new key generation (`meta.gen`), wrapped only for the people who stay; older generations are kept in `meta.past` so members can still read earlier messages. Files a removed person writes after their removal are shown as "Unverified sender". New members get the existing group key, so they can read what is still in the group (7 days at most). Only the creator re-signs the group's `meta.json` (with a higher `rev`), so it still has a single writer.
- **Attachments are saved with "Save as…"** instead of opening in a new tab. Downloads may be blocked, and blob tabs from `file://` pages are unreliable. Images open in an in-app viewer.
- **Mockups vs. requirements:** where they disagree, the requirements win: the name is Sankyo Chat, there's no Department field, the file limit is 5 MB (not 10 MB), and avatars are animals.
- **Not built:** the typing indicator (FR-24, "Could"). It would add many writes to the share.

## Known limits

- Anyone with write access to `data` can delete files. Signatures expose altered messages but can't prevent deletion, so keep backups.
- Anyone browsing the share can see who DMs whom and when (folder names and timestamps), file sizes, and channel messages.
- If someone forgets their password, the admin resets it and they lose their DMs from before the reset (7 days at most). The admin account itself can't be reset.
- Times come from each PC's clock. If clocks differ by a lot, messages can appear slightly out of order.
