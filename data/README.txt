Sankyo Chat data folder
=======================

All messages live in this folder. Staff need Modify access here (and only here).

  workspace.json        workspace settings, signed by the admin
  users\                profiles and password-protected security keys
  presence\             who is online (one small file per person)
  channels\             one folder per channel / conversation, one sub-folder per day
  files\                attachments (direct-message files are encrypted)
  inbox\                feedback for the super admin (encrypted)
  admin\                admin actions (renames, removals, resets), each signed by the admin

Do not edit or rename files by hand. Back this folder up daily: a copy of it is a
full backup (direct messages stay encrypted in the copy).
