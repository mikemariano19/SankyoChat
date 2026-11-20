<#
  Sankyo Chat - data backup and restore (Windows Task Scheduler)
  --------------------------------------------------------------
  The app backs up by itself while the super admin is signed in (Admin settings -> Backups).
  A browser page can't run while it's closed, so this script does the same job from Task
  Scheduler, around the clock, even when nobody is signed in to Windows. Both write the
  same folders in the same backup location.

    Setup    Pick where backups go and turn on the hourly check.
    Backup   Check now: copy what changed into today's folder.
    Restore  Copy a backup back as the real "data" folder the app uses.
    Status   Show the settings, the scheduled task and the newest backups.
    Remove   Turn the hourly check off (backups already made are kept).

  How a backup works
    - One folder per day: data-YYYY-MM-DD. Every hour, new and changed files are copied
      into today's folder. If nothing changed, nothing is written.
    - Files are never deleted from a day's folder, so if part of data is deleted by
      accident, that day's backup still has it.
    - If data holds a different workspace than today's folder (someone started a new one
      over a deleted folder), today's folder is left alone and data-YYYY-MM-DD_2 is used.
    - workspace.json is copied last; a folder without it is unfinished and never restored.
    - Day folders older than KeepDays are deleted, but never while data is missing/empty.

  Restoring COPIES a backup into the data folder; the backup itself is never touched.
  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
[CmdletBinding()]
param(
  [ValidateSet('Setup', 'Backup', 'Restore', 'Status', 'Remove')]
  [string]$Action = 'Status',
  [switch]$Quiet   # set by the scheduled task: no prompts, log only
)

$ErrorActionPreference = 'Stop'
$TaskName     = 'SankyoChat hourly data backup'
$ScriptPath   = $MyInvocation.MyCommand.Path
$ScriptDir    = Split-Path -Parent $ScriptPath
$AppDir       = Split-Path -Parent $ScriptDir
$SettingsFile = Join-Path $ScriptDir 'backup-settings.json'
$Mark         = '.sankyo-backup.json'
# data-2026-11-21, data-2026-11-21_2 (second workspace that day), data-2026-11-21_14-00-00 (older hourly copies)
$NameRe       = '^data-(\d{4})-(\d{2})-(\d{2})(_\d{2}-\d{2}-\d{2}|_\d{1,2})?$'

# ---------------------------------------------------------------- settings

function Get-Settings {
  $s = [ordered]@{
    DataFolder   = (Join-Path $AppDir 'data')
    BackupFolder = ''
    KeepDays     = 30   # one folder per day, kept this many days
  }
  if (Test-Path -LiteralPath $SettingsFile) {
    $j = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
    foreach ($k in @($s.Keys)) { if ($null -ne $j.$k -and "$($j.$k)" -ne '') { $s[$k] = $j.$k } }
  }
  $s.KeepDays = [int]$s.KeepDays
  return $s
}

function Save-Settings($s, [string]$file = $SettingsFile) {
  ($s | ConvertTo-Json) | Out-File -LiteralPath $file -Encoding utf8
}

# ---------------------------------------------------------------- helpers

function Write-Log([string]$msg, [string]$backupFolder) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  if (-not $Quiet) { Write-Host $msg }
  if ($backupFolder -and (Test-Path -LiteralPath $backupFolder)) {
    try { Add-Content -LiteralPath (Join-Path $backupFolder 'backup-log.txt') -Value $line -Encoding utf8 } catch { }
  }
}

function Test-Inside([string]$child, [string]$parent) {
  $c = [IO.Path]::GetFullPath($child).TrimEnd('\') + '\'
  $p = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

function Get-FolderStats([string]$path) {
  $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -notlike '*.crswap' -and $_.Name -ne $Mark })
  [pscustomobject]@{
    Files = $files.Count
    Bytes = [long](($files | Measure-Object Length -Sum).Sum)
    MB    = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 2)
  }
}

function Read-Json([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# A usable workspace has its settings file. Without it the app would start a
# brand-new workspace, so never treat such a folder as good data.
function Test-Workspace([string]$path) {
  return (Test-Path -LiteralPath (Join-Path $path 'workspace.json'))
}

function Get-BackupDay($dir) {
  $m = [regex]::Match($dir.Name, $NameRe)
  return (New-Object DateTime ([int]$m.Groups[1].Value), ([int]$m.Groups[2].Value), ([int]$m.Groups[3].Value))
}

# When the backup was last updated: the app/script record, else the folder's time.
function Get-BackupTime($dir) {
  $info = Read-Json (Join-Path $dir.FullName $Mark)
  if ($info -and $info.ts) { return ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$info.ts)).LocalDateTime }
  $m = [regex]::Match($dir.Name, '_(\d{2})-(\d{2})-(\d{2})$')
  $day = Get-BackupDay $dir
  if ($m.Success) { return $day.AddHours([int]$m.Groups[1].Value).AddMinutes([int]$m.Groups[2].Value).AddSeconds([int]$m.Groups[3].Value) }
  if ($dir.LastWriteTime.Date -eq $day) { return $dir.LastWriteTime }
  return $day
}

function Get-Backups([string]$backupFolder) {
  if (-not $backupFolder -or -not (Test-Path -LiteralPath $backupFolder)) { return @() }
  @(Get-ChildItem -LiteralPath $backupFolder -Directory |
    Where-Object { $_.Name -match $NameRe } |
    Sort-Object @{ Expression = { Get-BackupTime $_ }; Descending = $true })
}

# Copy src into dst without deleting anything in dst. workspace.json goes last.
# robocopy exit codes: bit 1 = files copied, 8 and up = failures.
# Returns @{ Code; Copied } where Copied is the number of files copied.
function Sync-Folder([string]$from, [string]$to, [switch]$SkipPresence) {
  $common = @('/E', '/XX', '/COPY:DAT', '/DCOPY:T', '/R:3', '/W:2', '/NP', '/NDL', '/NJH', '/NJS', '/FP')
  $xd = @(); if ($SkipPresence) { $xd = @('/XD', (Join-Path $from 'presence')) }
  $out1 = & robocopy.exe $from $to @common /XF '*.crswap' $Mark 'workspace.json' @xd
  $c1 = $LASTEXITCODE
  $out2 = & robocopy.exe $from $to 'workspace.json' /XX /COPY:DAT /R:3 /W:2 /NP /NDL /NJH /NJS /FP
  $c2 = $LASTEXITCODE
  $copied = @($out1 + $out2 | Where-Object { $_ -and $_.Trim() }).Count
  return @{ Code = [math]::Max($c1, $c2); Copied = $copied }
}

function Require-BackupFolder($s) {
  if (-not $s.BackupFolder) {
    throw 'No backup location is set yet. Run "1 Set up hourly backup.bat" first.'
  }
}

function Pick-Folder([string]$suggest) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Choose where Sankyo Chat backups are saved: a folder on the shared storage OUTSIDE the SankyoChat folder.'
    $dlg.ShowNewFolderButton = $true
    if ($suggest -and (Test-Path -LiteralPath $suggest)) { $dlg.SelectedPath = $suggest }
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
  } catch { }
  return $null
}

# ---------------------------------------------------------------- actions

function Invoke-Backup {
  $s = Get-Settings
  Require-BackupFolder $s
  $data = $s.DataFolder
  $dest = $s.BackupFolder
  if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }

  # Never back up a missing or empty data folder, and never prune because of
  # one: that is exactly when the old backups are needed.
  if (-not (Test-Path -LiteralPath $data)) {
    Write-Log "SKIPPED: data folder not found ($data). Backups kept. Open Sankyo Chat to restore." $dest
    return 2
  }
  $ws = Read-Json (Join-Path $data 'workspace.json')
  if (-not $ws -or -not $ws.id) {
    Write-Log "SKIPPED: $data has no workspace.json (empty or not a Sankyo Chat data folder). Backups kept." $dest
    return 2
  }

  # today's folder for THIS workspace
  $base = 'data-' + (Get-Date -Format 'yyyy-MM-dd')
  $day = $null
  for ($i = 1; $i -lt 20 -and -not $day; $i++) {
    $name = if ($i -eq 1) { $base } else { "${base}_$i" }
    $p = Join-Path $dest $name
    if (-not (Test-Path -LiteralPath $p)) { $day = $p; break }
    $info = Read-Json (Join-Path $p $Mark)
    $id = if ($info -and $info.wsId) { $info.wsId } else { $w = Read-Json (Join-Path $p 'workspace.json'); if ($w) { $w.id } else { $null } }
    if (-not $id -or $id -eq $ws.id) { $day = $p }
    elseif ($i -eq 1) { Write-Log "NOTE: data now holds a different workspace ('$($ws.name)'). $name was left untouched." $dest }
  }
  if (-not $day) { throw 'Too many different workspaces were backed up today.' }
  $dayName = Split-Path -Leaf $day

  $r = Sync-Folder $data $day -SkipPresence
  if ($r.Code -ge 8) {
    Write-Log "FAILED: robocopy exit code $($r.Code) while copying $data into $dayName." $dest
    return 1
  }
  if ($r.Copied -eq 0) {
    Write-Log "No changes since the last backup ($dayName)." $dest
    return 0
  }

  # update the record the app also reads (keep the app's own file list in it)
  $st = Get-FolderStats $day
  $markPath = Join-Path $day $Mark
  $info = Read-Json $markPath
  if (-not $info) { $info = [pscustomobject]@{ app = 'Sankyo Chat'; created = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } }
  $set = @{ ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); wsId = $ws.id; wsName = $ws.name; count = $st.Files; bytes = $st.Bytes; by = 'windows-task' }
  foreach ($k in $set.Keys) { $info | Add-Member -NotePropertyName $k -NotePropertyValue $set[$k] -Force }
  try { [IO.File]::WriteAllText($markPath, ($info | ConvertTo-Json -Depth 6 -Compress)) } catch { }

  Write-Log ("OK: {0} updated, {1} file(s) copied ({2} files, {3} MB in all)" -f $dayName, $r.Copied, $st.Files, $st.MB) $dest
  Remove-OldBackups $s
  return 0
}

function Remove-OldBackups($s) {
  $today = (Get-Date).Date
  $cutoff = $today.AddDays(-$s.KeepDays)
  foreach ($b in (Get-Backups $s.BackupFolder)) {
    $d = Get-BackupDay $b
    if ($d -ge $today) { continue }                          # never today's
    if ($d -ge $cutoff -and (Test-Workspace $b.FullName)) { continue }
    try { Remove-Item -LiteralPath $b.FullName -Recurse -Force; Write-Log "Removed old backup $($b.Name)" $s.BackupFolder }
    catch { Write-Log "Could not remove $($b.Name): $($_.Exception.Message)" $s.BackupFolder }
  }
}

function Register-BackupTask([string]$toolScript, [string]$backupFolder) {
  # conhost --headless keeps a console window from flashing up every hour.
  $psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$toolScript`" -Action Backup -Quiet"
  $act = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless powershell.exe $psArgs"
  $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
           -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
  $desc = "Checks the Sankyo Chat data folder every hour and saves changes into a daily folder in $backupFolder."

  Write-Host ''
  Write-Host 'Should the backup also run when nobody is signed in to Windows on this PC?'
  Write-Host '  Y = always (recommended on the file server). Windows asks for this account''s'
  Write-Host '      password once and stores it in Task Scheduler (Sankyo Chat never sees it).'
  Write-Host '  N = only while you are signed in to Windows here.'
  $always = (Read-Host 'Y or N (Enter = Y)').Trim() -notmatch '^[nN]'
  if ($always) {
    $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
    $cred = $null
    try { $cred = Get-Credential -UserName $user -Message 'Windows password for this account, so the backup can run while you are signed out.' } catch { }
    if ($cred) {
      try {
        Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Description $desc `
          -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
        Write-Host "Hourly backup is ON and runs even when nobody is signed in (Task Scheduler: '$TaskName')." -ForegroundColor Green
        return
      } catch {
        Write-Host "Windows didn't accept that: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '(Wrong password, or this account may not be allowed to run tasks while signed out. Ask IT, or run setup again.)'
      }
    }
    Write-Host 'Setting it up to run while you are signed in instead.' -ForegroundColor Yellow
  }
  Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Description $desc -Force | Out-Null
  Write-Host "Hourly backup is ON while you are signed in to Windows here (Task Scheduler: '$TaskName')." -ForegroundColor Green
}

function Invoke-Setup {
  $s = Get-Settings
  Write-Host ''
  Write-Host 'Sankyo Chat - set up hourly backup' -ForegroundColor Cyan
  Write-Host '==================================='
  Write-Host ''
  Write-Host "Data folder (what gets backed up): $($s.DataFolder)"
  $ans = Read-Host 'Press Enter to keep it, or type a different data folder path'
  if ($ans.Trim()) { $s.DataFolder = $ans.Trim().Trim('"') }
  if (-not (Test-Path -LiteralPath $s.DataFolder)) { Write-Host "Warning: $($s.DataFolder) does not exist right now." -ForegroundColor Yellow }

  $suggest = if ($s.BackupFolder) { $s.BackupFolder } else { Join-Path (Split-Path -Parent $AppDir) 'SankyoChat-Backups' }
  Write-Host ''
  Write-Host 'Where should backups be saved?'
  Write-Host '  Use a folder OUTSIDE the SankyoChat folder, so deleting the app or data folder'
  Write-Host '  can''t delete the backups. Use the same folder you chose in the app (Admin settings -> Backups).'
  Write-Host "  Suggested: $suggest"
  $ans = Read-Host 'Press Enter to use the suggestion, type a path, or type B to browse'
  $ans = $ans.Trim().Trim('"')
  if ($ans -eq 'B' -or $ans -eq 'b') {
    $picked = Pick-Folder $suggest
    if (-not $picked) { Write-Host 'No folder picked. Nothing changed.' -ForegroundColor Yellow; return 1 }
    $s.BackupFolder = $picked
  } elseif ($ans) { $s.BackupFolder = $ans } else { $s.BackupFolder = $suggest }

  if (Test-Inside $s.BackupFolder $s.DataFolder) {
    Write-Host 'The backup folder can''t be inside the data folder (deleting data would delete the backups too).' -ForegroundColor Red
    return 1
  }
  $dataParent = Split-Path -Parent ([IO.Path]::GetFullPath($s.DataFolder))
  if ($dataParent -and (Test-Inside $s.BackupFolder $dataParent)) {
    Write-Host "The backup folder can't be inside $dataParent (the app folder): deleting the app folder would delete the backups too." -ForegroundColor Red
    Write-Host 'Pick a separate folder on the shared storage, e.g. \\fileserver\Shared\SankyoChat-Backups'
    return 1
  }
  if (-not (Test-Path -LiteralPath $s.BackupFolder)) { New-Item -ItemType Directory -Path $s.BackupFolder -Force | Out-Null }
  $s.BackupFolder = (Resolve-Path -LiteralPath $s.BackupFolder).ProviderPath
  $s.DataFolder   = [IO.Path]::GetFullPath($s.DataFolder)

  # Install a self-contained copy of the tools inside the backup folder, so the
  # hourly job and the restore tool keep working if the app folder is deleted.
  $tools = Join-Path $s.BackupFolder '_tools'
  if (-not (Test-Path -LiteralPath $tools)) { New-Item -ItemType Directory -Path $tools -Force | Out-Null }
  $toolScript = Join-Path $tools 'SankyoBackup.ps1'
  if ([IO.Path]::GetFullPath($ScriptPath) -ne [IO.Path]::GetFullPath($toolScript)) {
    Copy-Item -LiteralPath $ScriptPath -Destination $toolScript -Force
  }
  Save-Settings $s (Join-Path $tools 'backup-settings.json')
  Save-Settings $s   # also here, so the copy in the app folder knows the location
  $bat = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0_tools\SankyoBackup.ps1`" -Action {0}`r`necho.`r`npause`r`n"
  [IO.File]::WriteAllText((Join-Path $s.BackupFolder 'RESTORE data from backup.bat'), ($bat -f 'Restore'))
  [IO.File]::WriteAllText((Join-Path $s.BackupFolder 'Back up now.bat'), ($bat -f 'Backup'))
  [IO.File]::WriteAllText((Join-Path $s.BackupFolder 'Backup status.bat'), ($bat -f 'Status'))
  [IO.File]::WriteAllText((Join-Path $s.BackupFolder 'README - backups.txt'), @"
Sankyo Chat data backups
========================

One folder per day (data-YYYY-MM-DD) holds a copy of the Sankyo Chat data folder:
  $($s.DataFolder)
Every hour, new and changed files are copied into today's folder. If nothing
changed, nothing is written. Files are never deleted from a day's folder.
data-YYYY-MM-DD_2 means a different workspace appeared in data that day.

Data folder emptied or deleted?
  Easiest: open Sankyo Chat. On an empty data folder it offers to copy a backup back in.
  Or here: close Sankyo Chat on every PC, double-click "RESTORE data from backup.bat",
  pick a day, type YES. (If the app folder is gone, copy the app files back first.)
  Either way the backup is COPIED into data; the backup itself stays here untouched.

Checks run every hour from the Task Scheduler task "$TaskName"
on the PC where setup was run. History: backup-log.txt. Don't put files in _tools.
"@)
  Write-Host "Saved. Backups go to: $($s.BackupFolder)" -ForegroundColor Green
  Write-Host "Restore tool installed there too: $(Join-Path $s.BackupFolder 'RESTORE data from backup.bat')"

  Register-BackupTask $toolScript $s.BackupFolder
  Write-Host ''
  Write-Host 'Checking for changes now...'
  return (Invoke-Backup)
}

function Invoke-Restore {
  $s = Get-Settings
  if (-not $s.BackupFolder) {
    Write-Host 'No backup location is saved on this copy of the app.' -ForegroundColor Yellow
    $ans = Read-Host 'Type the folder that holds the data-YYYY-MM-DD backups (or B to browse)'
    $ans = $ans.Trim().Trim('"')
    if ($ans -eq 'B' -or $ans -eq 'b') { $ans = Pick-Folder '' }
    if (-not $ans) { Write-Host 'Nothing picked. Nothing changed.'; return 1 }
    $s.BackupFolder = $ans
  }
  $backups = @(Get-Backups $s.BackupFolder | Where-Object { Test-Workspace $_.FullName })
  if ($backups.Count -eq 0) { Write-Host "No usable backups found in $($s.BackupFolder)." -ForegroundColor Red; return 1 }

  Write-Host ''
  Write-Host 'Sankyo Chat - restore data from a backup' -ForegroundColor Cyan
  Write-Host '========================================='
  Write-Host "Data folder the app uses: $($s.DataFolder)"
  if (Test-Path -LiteralPath $s.DataFolder) {
    $cur = Get-FolderStats $s.DataFolder
    Write-Host ("  right now: {0} files, {1} MB{2}" -f $cur.Files, $cur.MB, $(if (Test-Workspace $s.DataFolder) { '' } else { '  (no workspace.json - looks empty/broken)' }))
  } else { Write-Host '  right now: MISSING' -ForegroundColor Yellow }
  Write-Host ''
  Write-Host 'Backups (newest first, each as it was at its last update):'
  $show = [math]::Min($backups.Count, 31)
  for ($i = 0; $i -lt $show; $i++) {
    $b = $backups[$i]; $st = Get-FolderStats $b.FullName; $info = Read-Json (Join-Path $b.FullName $Mark)
    $label = if ($info -and $info.wsName) { "  $($info.wsName)" } else { '' }
    Write-Host ('  {0,2}.  {1,-20} as of {2:ddd dd MMM HH:mm}   {3,5} files {4,8} MB{5}' -f ($i + 1), $b.Name, (Get-BackupTime $b), $st.Files, $st.MB, $label)
  }
  if ($backups.Count -gt $show) { Write-Host "  ... and $($backups.Count - $show) older ones in $($s.BackupFolder)" }
  Write-Host ''
  $ans = Read-Host "Which backup? Press Enter for 1 (the newest), or type a number 1-$show"
  $n = 1
  if ($ans.Trim()) { if (-not [int]::TryParse($ans.Trim(), [ref]$n) -or $n -lt 1 -or $n -gt $show) { Write-Host 'Not a valid number. Nothing changed.'; return 1 } }
  $pick = $backups[$n - 1]

  Write-Host ''
  Write-Host 'BEFORE YOU CONTINUE: close Sankyo Chat on every PC (all Edge/Chrome tabs with it).' -ForegroundColor Yellow
  Write-Host "This copies $($pick.Name) into $($s.DataFolder)."
  Write-Host 'Messages written after that backup are not in it.'
  Write-Host 'If a data folder is there now, it is renamed (kept), not deleted.'
  if ((Read-Host 'Type YES to restore').Trim() -ne 'YES') { Write-Host 'Cancelled. Nothing changed.'; return 1 }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { $task | Disable-ScheduledTask | Out-Null }
  try {
    $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    if (Test-Path -LiteralPath $s.DataFolder) {
      $old = "data-replaced-$stamp"
      try { Rename-Item -LiteralPath $s.DataFolder -NewName $old }
      catch {
        Write-Host "Could not rename the current data folder: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host 'Someone probably still has Sankyo Chat open, or a file in it is open. Close it everywhere and run this again.'
        return 1
      }
      Write-Host "Old data folder kept as: $(Join-Path (Split-Path -Parent $s.DataFolder) $old)"
    }
    $r = Sync-Folder $pick.FullName $s.DataFolder
    if ($r.Code -ge 8 -or -not (Test-Workspace $s.DataFolder)) {
      Write-Host "Restore FAILED (robocopy exit code $($r.Code)). The backup itself is untouched: $($pick.FullName)" -ForegroundColor Red
      return 1
    }
    $st = Get-FolderStats $s.DataFolder
    Write-Log ("RESTORED {0} into {1} ({2} files)" -f $pick.Name, $s.DataFolder, $st.Files) $s.BackupFolder
    Write-Host ''
    Write-Host 'Done. The data folder is back and is a normal working copy (the backup was not moved).' -ForegroundColor Green
    Write-Host 'Open Sankyo Chat again. If it asks for the data folder, pick:'
    Write-Host "  $($s.DataFolder)"
    Write-Host 'Everyone signs in with the password they had at the time of that backup.'
    return 0
  } finally {
    if ($task) { $task | Enable-ScheduledTask | Out-Null }
  }
}

function Invoke-Status {
  $s = Get-Settings
  Write-Host "Data folder:    $($s.DataFolder)  $(if (Test-Path -LiteralPath $s.DataFolder) { '' } else { '(MISSING)' })"
  Write-Host "Backup folder:  $(if ($s.BackupFolder) { $s.BackupFolder } else { '(not set - run Setup)' })"
  Write-Host "Keeping:        one folder per day for $($s.KeepDays) days"
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    $i = $t | Get-ScheduledTaskInfo
    $who = if ($t.Principal.LogonType -eq 'Password') { 'always, even when signed out' } else { 'while signed in' }
    Write-Host "Hourly task:    $($t.State) ($who)   last run $($i.LastRunTime)  (result $($i.LastTaskResult))   next run $($i.NextRunTime)"
  } else { Write-Host 'Hourly task:    OFF (not set up on this PC)' }
  $b = Get-Backups $s.BackupFolder
  Write-Host "Backups:        $($b.Count)"
  $b | Select-Object -First 5 | ForEach-Object { Write-Host ("                {0,-20} as of {1:ddd dd MMM HH:mm}" -f $_.Name, (Get-BackupTime $_)) }
  return 0
}

function Invoke-Remove {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host 'Hourly backup turned OFF. Existing backups were kept.'
  } else { Write-Host 'Hourly backup was not set up on this PC.' }
  return 0
}

# ---------------------------------------------------------------- main

try {
  $code = switch ($Action) {
    'Setup'   { Invoke-Setup }
    'Backup'  { Invoke-Backup }
    'Restore' { Invoke-Restore }
    'Status'  { Invoke-Status }
    'Remove'  { Invoke-Remove }
  }
  exit ([int]($code | Select-Object -Last 1))
} catch {
  $s = $null; try { $s = Get-Settings } catch { }
  Write-Log "ERROR ($Action): $($_.Exception.Message)" $(if ($s) { $s.BackupFolder } else { '' })
  if ($Quiet) { exit 1 }
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
