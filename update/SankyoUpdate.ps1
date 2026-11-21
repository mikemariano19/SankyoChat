<#
  Sankyo Chat - app updater
  -------------------------
  Replaces the app's code files (index.html, check.html, css, js, assets, the backup and
  update tools) from an update package, and never touches anything else. The data folder
  can't be written, moved or deleted by this script, whatever the package says.

    Update Sankyo Chat.bat     open the updater window (drop a package on it, or choose one)
    Undo last update.bat       put back the version from before the last update

  Console use (IT, testing):
    SankyoUpdate.ps1 -NoGui -Package <zip or folder> [-WhatIf] [-Yes] [-NoBackup]
    SankyoUpdate.ps1 -NoGui -Undo [-Yes]

  How an update works
    1. The package (a zip or folder with sankyo-update.json) is copied into _updates\staging
       and checked: every file's size and SHA-256, a newer version, and every path on the
       allowlist below. Anything wrong stops here with nothing changed.
    2. Update mode must be on (the super admin clicks Start update in the app first).
    3. The app files about to change are copied into _updates\app-<old version>-<time>.
    4. Changed files are replaced, new ones added, and files the old version had but the
       new one doesn't are removed (single files only, never folders).
    5. Every file is checked again, and data is checked: no file may have gone missing.
       If anything is off, the old files are put back automatically.

  Allowlist (the only paths this script writes or deletes):
    index.html  check.html  README.md  data\README.txt
    css\**  js\**  assets\**  backup\*.ps1  backup\*.bat  update\*.ps1  update\*.bat
    _updates\** (its own staging, old-version copies and log)

  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Package = '',
  [switch]$Undo,
  [switch]$NoGui,
  [switch]$Yes,
  [switch]$WhatIf,
  [switch]$NoBackup,
  [switch]$AllowDowngrade,
  [switch]$SkipModeCheck,
  [switch]$RegisterLink,     # Set up updater button.bat: lets the app's "Open the updater" button start this script
  [switch]$UnregisterLink    # Remove updater button.bat
)

$ErrorActionPreference = 'Stop'
$ScriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir        = [IO.Path]::GetFullPath((Split-Path -Parent $ScriptDir))
$DataDir       = Join-Path $AppDir 'data'
$WorkDir       = Join-Path $AppDir '_updates'
$Staging       = Join-Path $WorkDir 'staging'
$LogFile       = Join-Path $WorkDir 'update-log.txt'
$LockFile      = Join-Path $WorkDir 'update.lock'
$InstalledFile = Join-Path $WorkDir 'installed.json'
$ManifestName  = 'sankyo-update.json'
$KeepCopies    = 5
$script:Progress = $null
$script:HaveLock = $false

# ================================================================ helpers

function Write-Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  if ($NoGui) { Write-Host $msg }
  try {
    if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
  } catch { }
}

# The useful part of an error: .NET calls wrap the real message in "Exception calling ...".
function Get-ErrorText($err) {
  $e = $err.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  $msg = $e.Message
  if ($e -is [UnauthorizedAccessException]) { $msg = 'Windows refused access (the file is read-only, open elsewhere, or this account may not change it).' }
  elseif ($e -is [IO.IOException]) { $msg = "The file is in use or the shared drive dropped. ($msg)" }
  return $msg
}

function Report([string]$step, [string]$state, [string]$detail = '', [int]$done = 0, [int]$total = 0) {
  if ($script:Progress) { & $script:Progress $step $state $detail $done $total }
}

function Test-Inside([string]$child, [string]$parent) {
  $c = [IO.Path]::GetFullPath($child).TrimEnd('\') + '\'
  $p = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

function Read-Json([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Write-Json($obj, [string]$path) {
  [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-Version([string]$s) {
  $v = $null
  if ([version]::TryParse(("$s").Trim(), [ref]$v)) { return $v }
  return $null
}

function Get-VersionFromFile([string]$versionJs) {
  if (-not (Test-Path -LiteralPath $versionJs)) { return $null }
  $m = [regex]::Match((Get-Content -LiteralPath $versionJs -Raw -Encoding UTF8), "APP_VERSION\s*=\s*['""]([^'""]+)['""]")
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

function Get-InstalledVersion { Get-VersionFromFile (Join-Path $AppDir 'js\version.js') }

function Get-Target([string]$rel) { Join-Path $AppDir ($rel.Replace('/', '\')) }

# The allowlist. $lower uses forward slashes.
function Test-Allowed([string]$lower) {
  if (@('index.html', 'check.html', 'readme.md', 'data/readme.txt') -contains $lower) { return $true }
  if ($lower -match '^(css|js|assets)/.+') { return $true }
  if ($lower -match '^(backup|update)/[^/]+\.(ps1|bat)$') { return $true }
  return $false
}

# $null when the updater may write or delete this app-relative path, else the reason it may not.
function Get-PathProblem([string]$rel) {
  if ([string]::IsNullOrWhiteSpace($rel)) { return 'empty path' }
  $p = $rel.Replace('\', '/')
  if ($p.StartsWith('/') -or $p.Contains(':')) { return 'not a relative path' }
  if ($p -match '[\x00-\x1f<>"|?*]') { return 'bad characters in the name' }
  foreach ($seg in $p.Split('/')) {
    if ($seg -eq '' -or $seg -eq '.' -or $seg -eq '..') { return 'bad path' }
    if ($seg.Trim() -ne $seg -or $seg.EndsWith('.') -or $seg -match '~\d') { return 'bad file or folder name' }
  }
  $full = [IO.Path]::GetFullPath((Get-Target $p))
  if (-not (Test-Inside $full $AppDir)) { return 'outside the app folder' }
  $lower = $p.ToLowerInvariant()
  if ($lower -ne 'data/readme.txt' -and (Test-Inside $full $DataDir)) { return 'inside the data folder' }
  if (Test-Inside $full $WorkDir) { return 'inside _updates' }
  if (-not (Test-Allowed $lower)) { return 'not an app file' }
  # a folder on the way that is a link (junction) could point anywhere, data included
  $dir = Split-Path -Parent $full
  while ($dir -and (Test-Inside $dir $AppDir) -and ($dir.TrimEnd('\') -ne $AppDir.TrimEnd('\'))) {
    if (Test-Path -LiteralPath $dir) {
      if ((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return 'a folder on the way is a link' }
    }
    $dir = Split-Path -Parent $dir
  }
  return $null
}

function Assert-SafePath([string]$rel) {
  $why = Get-PathProblem $rel
  if ($why) { throw "Refused to touch $rel ($why)." }
}

function Copy-OneFile([string]$from, [string]$to) {
  $parent = Split-Path -Parent $to
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::Copy($from, $to, $true)
}

function Get-UpdateMode {
  $wsFile = Join-Path $DataDir 'workspace.json'
  if (-not (Test-Path -LiteralPath $wsFile)) { return 'none' }   # no workspace yet: nobody to pause
  $ws = Read-Json $wsFile
  if ($ws -and $ws.maintenance -and $ws.maintenance.on) { return 'on' }
  return 'off'
}

# Every data file except presence (the super admin's own app keeps writing it).
function Get-DataSnapshot {
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  if (-not (Test-Path -LiteralPath $DataDir)) { return , $set }
  $root = $DataDir.TrimEnd('\') + '\'
  foreach ($f in (Get-ChildItem -LiteralPath $DataDir -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $rel = $f.FullName.Substring($root.Length)
    if ($rel -like 'presence\*' -or $f.Name -like '*.crswap') { continue }
    [void]$set.Add($rel)
  }
  return , $set
}

function Get-ProtectedList {
  $list = @('data\')
  if (Test-Path -LiteralPath (Join-Path $AppDir 'backup\backup-settings.json')) { $list += 'backup\backup-settings.json' }
  foreach ($d in (Get-ChildItem -LiteralPath $AppDir -Directory -Force -ErrorAction SilentlyContinue)) {
    if ($d.Name -like 'data-backup-*' -or $d.Name -like 'data-replaced-*') { $list += ($d.Name + '\') }
  }
  return $list
}

function Test-BackupAvailable {
  $settings = Read-Json (Join-Path $AppDir 'backup\backup-settings.json')
  return ($settings -and $settings.BackupFolder -and (Test-Path -LiteralPath (Join-Path $AppDir 'backup\SankyoBackup.ps1')))
}

# 0 = backed up (or nothing changed), anything else = failed or skipped
function Invoke-DataBackup {
  $tool = Join-Path $AppDir 'backup\SankyoBackup.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool -Action Backup -Quiet | Out-Null
  return $LASTEXITCODE
}

function Test-CanWrite {
  try {
    if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    foreach ($dir in @($WorkDir, (Join-Path $AppDir 'js'))) {
      $probe = Join-Path $dir ('.write-test-' + [guid]::NewGuid().ToString('N') + '.tmp')
      [IO.File]::WriteAllText($probe, 'x')
      Remove-Item -LiteralPath $probe -Force
    }
    return $true
  } catch { return $false }
}

function Enter-Lock([switch]$Force) {
  if (Test-Path -LiteralPath $LockFile) {
    $age = (Get-Date) - (Get-Item -LiteralPath $LockFile).LastWriteTime
    if ($age.TotalHours -lt 1 -and -not $Force) {
      throw ('Another update is running (started at {0}). Wait for it to finish.' -f (Get-Item -LiteralPath $LockFile).LastWriteTime.ToString('HH:mm'))
    }
    Write-Log 'Cleared an old lock file left by an update that did not finish.'
  }
  if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
  [IO.File]::WriteAllText($LockFile, ('{0} {1} {2}' -f $env:COMPUTERNAME, $env:USERNAME, $PID))
  $script:HaveLock = $true
}

# only ever removes a lock this run made
function Exit-Lock {
  if ($script:HaveLock -and (Test-Path -LiteralPath $LockFile)) { Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue }
  $script:HaveLock = $false
}

function Write-WorkReadme {
  $f = Join-Path $WorkDir 'README.txt'
  if (Test-Path -LiteralPath $f) { return }
  $text = @(
    'Sankyo Chat updater folder'
    '=========================='
    ''
    'Made by update\Update Sankyo Chat.bat. Nothing here is needed to run the app.'
    ''
    '  installed.json        the list of app files the current version installed'
    '  app-<version>-<time>\ the app files from before an update (used by Undo last update)'
    '  update-log.txt        what every update did'
    '  staging\              the last package while it was checked'
    ''
    'The newest ' + $KeepCopies + ' old-version copies are kept. Do not put anything else here.'
  )
  [IO.File]::WriteAllLines($f, $text)
}

# ================================================================ package

# Copies a zip or folder into _updates\staging, then checks it. Never touches the app.
function Open-Package([string]$path) {
  $problems = New-Object System.Collections.ArrayList
  $pkg = [pscustomobject]@{ Source = $path; Name = (Split-Path -Leaf $path); Manifest = $null; Version = ''; Problems = $problems; Files = @() }
  $installed = Get-InstalledVersion
  Write-Log "Checking package $path (installed version: $installed)"

  if (-not (Test-Path -LiteralPath $path)) { [void]$problems.Add('The package was not found.'); return $pkg }
  if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
  if (Test-Path -LiteralPath $Staging) {
    if (-not (Test-Inside $Staging $WorkDir)) { throw 'Staging folder is in the wrong place.' }
    Remove-Item -LiteralPath $Staging -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Staging -Force | Out-Null

  $isZip = (Test-Path -LiteralPath $path -PathType Leaf)
  $entries = @()   # relative paths found in the package, forward slashes
  try {
    if ($isZip) {
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [IO.Compression.ZipFile]::OpenRead($path)
      try {
        $total = 0L
        foreach ($e in $zip.Entries) {
          $rel = $e.FullName.Replace('\', '/')
          if ($rel.EndsWith('/')) { continue }   # a folder entry
          $total += $e.Length
          if ($total -gt 200MB) { [void]$problems.Add('The package is bigger than 200 MB.'); break }
          if ($rel -ne $ManifestName) {
            $why = Get-PathProblem $rel
            if ($why) { [void]$problems.Add("${rel}: $why"); continue }
          }
          $dest = Join-Path $Staging ($rel.Replace('/', '\'))
          if (-not (Test-Inside $dest $Staging)) { [void]$problems.Add("${rel}: outside the package"); continue }
          $parent = Split-Path -Parent $dest
          if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
          [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
          $entries += $rel
        }
      } finally { $zip.Dispose() }
    } else {
      $root = [IO.Path]::GetFullPath($path).TrimEnd('\') + '\'
      foreach ($f in (Get-ChildItem -LiteralPath $path -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($root.Length).Replace('\', '/')
        if ($rel -ne $ManifestName) {
          $why = Get-PathProblem $rel
          if ($why) { [void]$problems.Add("${rel}: $why"); continue }
        }
        Copy-OneFile $f.FullName (Join-Path $Staging ($rel.Replace('/', '\')))
        $entries += $rel
      }
    }
  } catch {
    [void]$problems.Add("The package could not be opened: $($_.Exception.Message)")
    return $pkg
  }

  $m = Read-Json (Join-Path $Staging $ManifestName)
  if (-not $m) { [void]$problems.Add("$ManifestName is missing or unreadable. This is not a Sankyo Chat update package."); return $pkg }
  if ($m.app -ne 'SankyoChat') { [void]$problems.Add('The package is not for Sankyo Chat.') }
  $pkg.Manifest = $m
  $pkg.Version = "$($m.version)"
  $newV = ConvertTo-Version $m.version
  if (-not $newV) { [void]$problems.Add("The package version '$($m.version)' is not valid.") }
  if (-not $m.files -or @($m.files).Count -eq 0) { [void]$problems.Add('The package lists no files.'); return $pkg }

  $listed = @{}
  foreach ($f in @($m.files)) {
    $rel = "$($f.path)".Replace('\', '/')
    $key = $rel.ToLowerInvariant()
    if ($listed.ContainsKey($key)) { [void]$problems.Add("${rel}: listed twice"); continue }
    $listed[$key] = $true
    $why = Get-PathProblem $rel
    if ($why) { [void]$problems.Add("${rel}: $why"); continue }
    $staged = Join-Path $Staging ($rel.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) { [void]$problems.Add("${rel}: missing from the package"); continue }
    if ((Get-Item -LiteralPath $staged).Length -ne [long]$f.size) { [void]$problems.Add("${rel}: wrong size. The file is damaged or was changed."); continue }
    if ((Get-Sha256 $staged) -ne "$($f.sha256)".ToLowerInvariant()) { [void]$problems.Add("${rel}: doesn't match its fingerprint. The file is damaged or was changed."); continue }
  }
  foreach ($rel in $entries) {
    if ($rel -ne $ManifestName -and -not $listed.ContainsKey($rel.ToLowerInvariant())) { [void]$problems.Add("${rel}: not listed in $ManifestName") }
  }
  $pkg.Files = @($m.files)

  if (-not $listed.ContainsKey('js/version.js')) { [void]$problems.Add('The package has no js/version.js.') }
  else {
    $pv = Get-VersionFromFile (Join-Path $Staging 'js\version.js')
    if ($pv -ne "$($m.version)") { [void]$problems.Add("js/version.js says $pv but the package says $($m.version).") }
  }
  foreach ($must in @('index.html')) {
    if (-not $listed.ContainsKey($must)) { [void]$problems.Add("The package has no $must.") }
  }

  $curV = ConvertTo-Version $installed
  if ($newV -and $curV -and $newV -le $curV -and -not $AllowDowngrade) {
    [void]$problems.Add("The package is version $($m.version), which isn't newer than the installed $installed.")
  }
  $minV = ConvertTo-Version $m.minFromVersion
  if ($minV -and $curV -and $curV -lt $minV) {
    [void]$problems.Add("This package needs version $($m.minFromVersion) or newer installed first (installed: $installed).")
  }

  $pkg.Problems = @($problems | Select-Object -Unique)
  if ($pkg.Problems.Count) { foreach ($p in $pkg.Problems) { Write-Log "  REFUSED: $p" } }
  else { Write-Log ("  Package OK: version {0}, {1} files" -f $m.version, @($m.files).Count) }
  return $pkg
}

# What will change: replace (differs), add (new), remove (old version had it), same (identical).
function Get-Plan($pkg) {
  $plan = [pscustomobject]@{ Replace = @(); Add = @(); Remove = @(); Same = @() }
  $newSet = @{}
  foreach ($f in $pkg.Files) {
    $rel = "$($f.path)".Replace('\', '/')
    $newSet[$rel.ToLowerInvariant()] = $true
    $t = Get-Target $rel
    if (-not (Test-Path -LiteralPath $t -PathType Leaf)) { $plan.Add += $rel }
    elseif ((Get-Sha256 $t) -eq "$($f.sha256)".ToLowerInvariant()) { $plan.Same += $rel }
    else { $plan.Replace += $rel }
  }
  # only files the installed version's list names; on the first run there is no list, so nothing is removed
  $old = Read-Json $InstalledFile
  if ($old -and $old.files) {
    foreach ($f in @($old.files)) {
      $rel = "$($f.path)".Replace('\', '/')
      if ($newSet.ContainsKey($rel.ToLowerInvariant())) { continue }
      if (-not (Test-Path -LiteralPath (Get-Target $rel) -PathType Leaf)) { continue }
      if (Get-PathProblem $rel) { continue }
      $plan.Remove += $rel
    }
  }
  return $plan
}

# ================================================================ install / undo

# Puts back what an old-version copy holds. Returns a list of files that could not be put back.
function Restore-FromCopy([string]$copyDir) {
  $failed = New-Object System.Collections.ArrayList
  $info = Read-Json (Join-Path $copyDir 'undo.json')
  if (-not $info) { return @('undo.json is missing') }
  $files = Join-Path $copyDir 'files'
  foreach ($rel in @($info.existed)) {
    if (-not $rel) { continue }
    try {
      Assert-SafePath $rel
      $src = Join-Path $files ($rel.Replace('/', '\'))
      $t = Get-Target $rel
      if ((Test-Path -LiteralPath $t -PathType Leaf) -and (Get-Sha256 $src) -eq (Get-Sha256 $t)) { continue }   # already the old file
      Copy-OneFile $src $t
      if ((Get-Sha256 $src) -ne (Get-Sha256 (Get-Target $rel))) { throw 'copy does not match' }
    } catch { [void]$failed.Add("${rel}: $($_.Exception.Message)") }
  }
  foreach ($rel in @($info.added)) {
    if (-not $rel) { continue }
    try {
      Assert-SafePath $rel
      $t = Get-Target $rel
      if (Test-Path -LiteralPath $t -PathType Leaf) { Remove-Item -LiteralPath $t -Force }
    } catch { [void]$failed.Add("${rel}: $($_.Exception.Message)") }
  }
  try {
    $saved = Join-Path $copyDir 'installed.json'
    if (Test-Path -LiteralPath $saved) { Copy-OneFile $saved $InstalledFile }
    elseif (Test-Path -LiteralPath $InstalledFile) { Remove-Item -LiteralPath $InstalledFile -Force }
  } catch { [void]$failed.Add("installed.json: $($_.Exception.Message)") }
  return $failed.ToArray()
}

function Set-UndoRecord([string]$copyDir, [hashtable]$fields) {
  $p = Join-Path $copyDir 'undo.json'
  $info = Read-Json $p
  if (-not $info) { return }
  foreach ($k in $fields.Keys) { $info | Add-Member -NotePropertyName $k -NotePropertyValue $fields[$k] -Force }
  Write-Json $info $p
}

function Remove-OldCopies {
  $copies = @(Get-ChildItem -LiteralPath $WorkDir -Directory -Force | Where-Object { $_.Name -like 'app-*' } | Sort-Object LastWriteTime -Descending)
  foreach ($d in ($copies | Select-Object -Skip $KeepCopies)) {
    if (Test-Inside $d.FullName $WorkDir) {
      Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
      Write-Log "  Removed old copy $($d.Name)"
    }
  }
}

function Invoke-Install($pkg, $plan) {
  $from = Get-InstalledVersion
  $to = $pkg.Version
  $result = [pscustomobject]@{ Ok = $false; RolledBack = $false; Reason = ''; RestoreFailed = @(); CopyDir = ''; From = $from; To = $to; Checked = 0 }
  $ts = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
  $copyDir = Join-Path $WorkDir ("app-$from-$ts")
  $result.CopyDir = $copyDir
  Write-Log ("Installing {0} -> {1}: {2} to replace, {3} to add, {4} to remove, {5} unchanged" -f $from, $to, $plan.Replace.Count, $plan.Add.Count, $plan.Remove.Count, $plan.Same.Count)

  # 1. keep the old files
  Report 'keep' 'run'
  $existed = @($plan.Replace) + @($plan.Remove)
  New-Item -ItemType Directory -Path (Join-Path $copyDir 'files') -Force | Out-Null
  foreach ($rel in $existed) {
    $dst = Join-Path (Join-Path $copyDir 'files') ($rel.Replace('/', '\'))
    Copy-OneFile (Get-Target $rel) $dst
    if ((Get-Sha256 (Get-Target $rel)) -ne (Get-Sha256 $dst)) { throw "Could not make a good copy of $rel. Nothing was changed." }
  }
  if (Test-Path -LiteralPath $InstalledFile) { Copy-OneFile $InstalledFile (Join-Path $copyDir 'installed.json') }
  Write-Json ([pscustomobject]@{ fromVersion = $from; toVersion = $to; ts = $ts; by = "$env:USERNAME on $env:COMPUTERNAME"; existed = $existed; added = @($plan.Add); undone = $false }) (Join-Path $copyDir 'undo.json')
  Write-Log "  Old files kept in $(Split-Path -Leaf $copyDir)"
  Report 'keep' 'done'

  $before = Get-DataSnapshot

  # 2. replace, add, remove
  $failure = ''
  $work = @($plan.Replace) + @($plan.Add)
  $n = 0; $total = $work.Count + $plan.Remove.Count
  $rel = ''
  Report 'replace' 'run' '' 0 $total
  try {
    foreach ($rel in $work) {
      Assert-SafePath $rel
      Copy-OneFile (Join-Path $Staging ($rel.Replace('/', '\'))) (Get-Target $rel)
      $n++; Report 'replace' 'run' $rel $n $total
    }
    foreach ($rel in $plan.Remove) {
      Assert-SafePath $rel
      Remove-Item -LiteralPath (Get-Target $rel) -Force
      Write-Log "  Removed $rel"
      $n++; Report 'replace' 'run' $rel $n $total
    }
    Report 'replace' 'done'
  } catch {
    $failure = "Copying stopped at $rel. $(Get-ErrorText $_)"
    Report 'replace' 'fail'
  }

  # 3. check every file
  if (-not $failure) { try {
    Report 'verify' 'run'
    foreach ($f in $pkg.Files) {
      $rel = "$($f.path)".Replace('\', '/')
      $t = Get-Target $rel
      if (-not (Test-Path -LiteralPath $t -PathType Leaf) -or (Get-Sha256 $t) -ne "$($f.sha256)".ToLowerInvariant()) {
        $failure = "After copying, $rel didn't match the package. The shared drive may have dropped for a moment."
        break
      }
      $result.Checked++
    }
    foreach ($rel in $plan.Remove) {
      if (Test-Path -LiteralPath (Get-Target $rel)) { $failure = "$rel could not be removed." }
    }
    if ($failure) { Report 'verify' 'fail' } else { Report 'verify' 'done' }
  } catch { $failure = "Checking the new files failed: $($_.Exception.Message)"; Report 'verify' 'fail' } }

  # 4. data must be untouched
  if (-not $failure) { try {
    Report 'data' 'run'
    $after = Get-DataSnapshot
    $missing = @($before | Where-Object { -not $after.Contains($_) })
    if ($missing.Count) {
      $failure = "$($missing.Count) file(s) went missing from data during the update (first: data\$($missing[0]))."
      Report 'data' 'fail'
    } else { Report 'data' 'done' }
  } catch { $failure = "Checking data failed: $($_.Exception.Message)"; Report 'data' 'fail' } }

  if ($failure) {
    Write-Log "  FAILED: $failure Putting $from back."
    $result.Reason = $failure
    $result.RestoreFailed = @(Restore-FromCopy $copyDir)
    Set-UndoRecord $copyDir @{ undone = $true; undoneTs = (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'); undoneReason = $failure }
    $result.RolledBack = $true
    if ($result.RestoreFailed.Count) { foreach ($x in $result.RestoreFailed) { Write-Log "  COULD NOT PUT BACK: $x" } }
    else { Write-Log "  Rolled back: $from is in place again." }
    return $result
  }

  Copy-OneFile (Join-Path $Staging $ManifestName) $InstalledFile
  Remove-OldCopies
  try { Remove-Item -LiteralPath $Staging -Recurse -Force } catch { }
  Write-Log "  OK: $to installed, $($result.Checked) files checked, data unchanged."
  $result.Ok = $true
  return $result
}

function Get-LastUndo {
  if (-not (Test-Path -LiteralPath $WorkDir)) { return $null }
  foreach ($d in (Get-ChildItem -LiteralPath $WorkDir -Directory -Force | Where-Object { $_.Name -like 'app-*' } | Sort-Object LastWriteTime -Descending)) {
    $info = Read-Json (Join-Path $d.FullName 'undo.json')
    if ($info -and -not $info.undone) { return [pscustomobject]@{ Dir = $d.FullName; Info = $info } }
  }
  return $null
}

function Invoke-Undo($last) {
  Write-Log ("Undo: putting back {0} (replacing {1}) from {2}" -f $last.Info.fromVersion, $last.Info.toVersion, (Split-Path -Leaf $last.Dir))
  $failed = @(Restore-FromCopy $last.Dir)
  if ($failed.Count) { foreach ($x in $failed) { Write-Log "  COULD NOT PUT BACK: $x" } }
  else {
    Set-UndoRecord $last.Dir @{ undone = $true; undoneTs = (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'); undoneReason = 'Undo last update' }
    Write-Log "  OK: $($last.Info.fromVersion) is back."
  }
  return $failed
}

# ================================================================ console

function Invoke-Console {
  if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'js\version.js'))) { throw "$AppDir doesn't look like the Sankyo Chat folder." }
  if (-not $WhatIf -and -not (Test-CanWrite)) { throw "This Windows account can't change the app files in $AppDir. Run the updater as the super admin or IT." }
  $mode = Get-UpdateMode
  $needMode = -not $SkipModeCheck -and -not $WhatIf

  if ($Undo) {
    $last = Get-LastUndo
    if (-not $last) { Write-Host 'There is no update to undo.'; return 0 }
    Write-Host ("Undo puts back {0} (replacing {1}, installed {2})." -f $last.Info.fromVersion, $last.Info.toVersion, $last.Info.ts)
    if ($needMode -and $mode -eq 'off') { Write-Host 'Update mode is off. In Sankyo Chat: Admin settings -> Settings -> Update the app -> Start update. Then run this again.' -ForegroundColor Yellow; return 3 }
    if ($WhatIf) { return 0 }
    if (-not $Yes -and (Read-Host 'Continue? (Y/N)') -notmatch '^[Yy]') { return 0 }
    Enter-Lock -Force:$Yes
    try { $failed = @(Invoke-Undo $last) } finally { Exit-Lock }
    if ($failed.Count) { Write-Host 'Some files could not be put back. See _updates\update-log.txt.' -ForegroundColor Red; return 4 }
    Write-Host "Done. Now click Finish update in the app." -ForegroundColor Green
    return 0
  }

  if (-not $Package) { throw 'Give the package: -Package <zip or folder>.' }
  $pkg = Open-Package $Package
  if ($pkg.Problems.Count) {
    Write-Host 'This package was refused. Nothing was changed:' -ForegroundColor Red
    foreach ($p in $pkg.Problems) { Write-Host "  $p" }
    return 2
  }
  $plan = Get-Plan $pkg
  Write-Host ''
  Write-Host ("Update {0} -> {1}" -f (Get-InstalledVersion), $pkg.Version)
  if ($pkg.Manifest.notes) { Write-Host "  $($pkg.Manifest.notes)" }
  foreach ($r in $plan.Replace) { Write-Host "  replace  $r" }
  foreach ($r in $plan.Add)     { Write-Host "  add      $r" }
  foreach ($r in $plan.Remove)  { Write-Host "  remove   $r" }
  Write-Host ("  ({0} unchanged)" -f $plan.Same.Count)
  Write-Host ('Not touched: ' + ((Get-ProtectedList) -join ', '))
  if ($WhatIf) { Write-Host 'WhatIf: nothing was changed.'; return 0 }
  if ($needMode -and $mode -eq 'off') { Write-Host 'Update mode is off. In Sankyo Chat: Admin settings -> Settings -> Update the app -> Start update. Then run this again.' -ForegroundColor Yellow; return 3 }
  if (-not $Yes -and (Read-Host 'Install this update? (Y/N)') -notmatch '^[Yy]') { Write-Host 'Cancelled. Nothing was changed.'; return 0 }

  Enter-Lock -Force:$Yes
  try {
    Write-WorkReadme
    if (-not $NoBackup -and (Test-BackupAvailable)) {
      Write-Host 'Backing up data...'
      $code = Invoke-DataBackup
      Write-Log "  Data backup before update: exit code $code"
      if ($code -ne 0 -and -not $Yes -and (Read-Host 'The backup did not finish. Update anyway? (Y/N)') -notmatch '^[Yy]') { return 0 }
    }
    $r = Invoke-Install $pkg $plan
  } finally { Exit-Lock }
  if ($r.Ok) {
    Write-Host ("Sankyo Chat {0} is installed. Now click Finish update in the app, then save the new trusted fingerprint (Admin settings -> App files)." -f $r.To) -ForegroundColor Green
    return 0
  }
  Write-Host "The update was undone: $($r.Reason)" -ForegroundColor Red
  if ($r.RestoreFailed.Count) { Write-Host "Some files could not be put back. Copy them from $($r.CopyDir)\files" -ForegroundColor Red }
  return 4
}

# ================================================================ window

function Start-Gui {
  $form = New-UpdaterForm
  if ($Undo) { $form.Add_Shown({ Start-UndoGui }) }
  elseif ($Package) { $script:StartPath = $Package; $form.Add_Shown({ Open-PackageGui $script:StartPath }) }
  Show-Start
  [Windows.Forms.Application]::Run($form)
}

function New-UpdaterForm {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [Windows.Forms.Application]::EnableVisualStyles()

  $script:G = @{ Pkg = $null; Plan = $null; Busy = $false; Steps = @{}; PkgPath = '' }
  $script:Arrow = [string][char]0x2192
  $script:Check = [string][char]0x2713

  $form = New-Object Windows.Forms.Form
  $form.Text = 'Sankyo Chat Updater'
  $form.ClientSize = New-Object Drawing.Size(720, 540)
  $form.FormBorderStyle = 'FixedSingle'
  $form.MaximizeBox = $false
  $form.StartPosition = 'CenterScreen'
  $form.BackColor = [Drawing.Color]::White
  $form.Font = New-Object Drawing.Font('Segoe UI', 10)
  $form.AllowDrop = $true
  $form.Add_FormClosing({ param($s, $e) if ($script:G.Busy) { $e.Cancel = $true } })
  $script:Form = $form

  $foot = New-Object Windows.Forms.Panel
  $foot.Dock = 'Bottom'; $foot.Height = 68; $foot.BackColor = (Col '#F9FAFB')
  $foot.Add_Paint({ param($s, $e) $e.Graphics.DrawLine((New-Object Drawing.Pen((Col '#E5E7EB'))), 0, 0, $s.Width, 0) })
  $body = New-Object Windows.Forms.Panel
  $body.Dock = 'Fill'
  $form.Controls.Add($body); $form.Controls.Add($foot)
  $script:Body = $body; $script:Foot = $foot
  Enable-Drop $form
  return $form
}

function Col([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }

function Add-Label($parent, [string]$text, [int]$x, [int]$y, [int]$w, [int]$h, [double]$size = 10, [switch]$Bold, [string]$color = '#111827', [switch]$Mono, [string]$align = 'TopLeft') {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text; $l.AutoSize = $false
  $l.SetBounds($x, $y, $w, $h)
  $family = 'Segoe UI'; if ($Mono) { $family = 'Consolas' }
  $style = [Drawing.FontStyle]::Regular; if ($Bold) { $style = [Drawing.FontStyle]::Bold }
  $l.Font = New-Object Drawing.Font($family, $size, $style)
  $l.ForeColor = (Col $color); $l.BackColor = [Drawing.Color]::Transparent
  $l.TextAlign = $align; $l.UseMnemonic = $false
  $parent.Controls.Add($l)
  return $l
}

function Add-Box($parent, [int]$x, [int]$y, [int]$w, [int]$h, [string]$back = '#FFFFFF', [string]$border = '#E5E7EB', [switch]$Dashed) {
  $p = New-Object Windows.Forms.Panel
  $p.SetBounds($x, $y, $w, $h)
  $p.BackColor = (Col $back)
  $p.Tag = @{ Border = (Col $border); Dashed = [bool]$Dashed }
  $p.Add_Paint({
    param($s, $e)
    $pen = New-Object Drawing.Pen($s.Tag.Border, 1)
    if ($s.Tag.Dashed) { $pen.Width = 2; $pen.DashStyle = 'Dash' }
    $e.Graphics.DrawRectangle($pen, 0, 0, $s.Width - 1, $s.Height - 1)
  })
  $parent.Controls.Add($p)
  return $p
}

function Add-Button($parent, [string]$text, [int]$x, [int]$y, [int]$w, [scriptblock]$onClick, [switch]$Primary, [switch]$Link) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text; $b.SetBounds($x, $y, $w, 40)
  $b.FlatStyle = 'Flat'; $b.Cursor = 'Hand'
  $b.Font = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)
  $b.UseMnemonic = $false
  if ($Primary) {
    $b.BackColor = (Col '#4F46E5'); $b.ForeColor = [Drawing.Color]::White; $b.FlatAppearance.BorderColor = (Col '#4F46E5')
    $b.FlatAppearance.MouseOverBackColor = (Col '#4338CA')
  } elseif ($Link) {
    $b.BackColor = (Col '#F9FAFB'); $b.ForeColor = (Col '#4F46E5'); $b.FlatAppearance.BorderSize = 0
    $b.FlatAppearance.MouseOverBackColor = (Col '#EEF2FF')
  } else {
    $b.BackColor = [Drawing.Color]::White; $b.ForeColor = (Col '#111827'); $b.FlatAppearance.BorderColor = (Col '#D1D5DB')
  }
  if ($onClick) { $b.Add_Click($onClick) }
  $parent.Controls.Add($b)
  return $b
}

# Footer: $left and $right are arrays of @{ Text; Click; Primary; Link; Width }
function Set-Footer([object[]]$left = @(), [object[]]$right = @(), [string]$note = '') {
  $script:Foot.Controls.Clear()
  $x = 16
  foreach ($b in $left) {
    $w = 150; if ($b.Width) { $w = $b.Width }
    $btn = Add-Button $script:Foot $b.Text $x 14 $w $b.Click -Link
    if ($b.Disabled) { $btn.Enabled = $false; $btn.ForeColor = (Col '#9CA3AF') }
    $x += $w + 4
  }
  if ($note) { [void](Add-Label $script:Foot $note 24 14 400 40 9.5 -color '#4B5563' -align 'MiddleLeft') }
  $x = 720 - 24
  for ($i = $right.Count - 1; $i -ge 0; $i--) {
    $b = $right[$i]
    $w = 110; if ($b.Width) { $w = $b.Width }
    $x -= $w
    $btn = Add-Button $script:Foot $b.Text $x 14 $w $b.Click -Primary:([bool]$b.Primary)
    if ($b.Disabled) { $btn.Enabled = $false }
    $x -= 8
  }
}

function New-Screen {
  foreach ($c in @($script:Body.Controls)) { $c.Dispose() }
  $script:Body.Controls.Clear()
  $script:Foot.Controls.Clear()
}

function Enable-Drop($ctl) {
  $ctl.AllowDrop = $true
  $ctl.Add_DragEnter({ param($s, $e)
    if (-not $script:G.Busy -and $script:G.Screen -eq 'start' -and $e.Data.GetDataPresent([Windows.Forms.DataFormats]::FileDrop)) { $e.Effect = 'Copy' } else { $e.Effect = 'None' } })
  $ctl.Add_DragDrop({ param($s, $e)
    $paths = $e.Data.GetData([Windows.Forms.DataFormats]::FileDrop)
    if ($paths -and $paths.Count) { $script:G.Dropped = $paths[0]; [void]$script:Form.BeginInvoke([Action]{ Open-PackageGui $script:G.Dropped }) } })
}

function Show-Error([string]$msg) {
  Write-Log "ERROR: $msg"
  [void][Windows.Forms.MessageBox]::Show($script:Form, $msg, 'Sankyo Chat Updater', 'OK', 'Error')
}

function Open-Log { if (Test-Path -LiteralPath $LogFile) { Start-Process notepad.exe -ArgumentList ('"' + $LogFile + '"') } }

function Add-VersionHeader([string]$from, [string]$to, [string]$right = '') {
  $l1 = Add-Label $script:Body $from 24 18 90 34 16 -Bold -color '#6B7280'
  $l1.AutoSize = $true
  $ax = $l1.Right + 4
  $la = Add-Label $script:Body $script:Arrow $ax 18 30 34 16 -color '#6B7280'
  $la.AutoSize = $true
  $l2 = Add-Label $script:Body $to ($la.Right + 4) 18 120 34 16 -Bold
  $l2.AutoSize = $true
  if ($right) { [void](Add-Label $script:Body $right 330 26 366 22 9 -Mono -color '#6B7280' -align 'TopRight') }
}

function Add-Banner([int]$y, [int]$h, [string]$kind, [string]$title, [string]$text) {
  $colors = @{ ok = @('#F0FDF4', '#BBF7D0', '#14532D', '#15803D'); warn = @('#FFFBEB', '#FDE68A', '#78350F', '#B45309'); bad = @('#FEF2F2', '#FECACA', '#7F1D1D', '#B91C1C') }
  $c = $colors[$kind]
  $box = Add-Box $script:Body 24 $y 672 $h $c[0] $c[1]
  $glyph = @{ ok = $script:Check; warn = '!'; bad = [string][char]0x2715 }[$kind]
  [void](Add-Label $box $glyph 12 8 26 28 14 -Bold -color $c[3] -align 'TopCenter')
  if ($text) {
    [void](Add-Label $box $title 44 9 610 22 10.5 -Bold -color $c[2])
    [void](Add-Label $box $text 44 31 610 ($h - 36) 9.5 -color $c[2])
  } else {
    [void](Add-Label $box $title 44 0 610 $h 10.5 -color $c[2] -align 'MiddleLeft')
  }
  return $box
}

function Add-Icon([string]$glyph, [string]$back, [string]$border, [string]$fore) {
  $b = Add-Box $script:Body 24 26 52 52 $back $border
  [void](Add-Label $b $glyph 0 0 52 52 18 -Bold -color $fore -align 'MiddleCenter')
}

# ---------------------------------------------------------------- screens

function Show-Start {
  New-Screen
  $script:G.Screen = 'start'
  $installed = Get-InstalledVersion
  [void](Add-Label $script:Body 'Update Sankyo Chat' 24 16 500 32 16 -Bold)
  $pathLabel = Add-Label $script:Body ("App folder   " + $AppDir) 24 50 672 20 9 -Mono -color '#6B7280'
  $pathLabel.AutoEllipsis = $true

  $c1 = Add-Box $script:Body 24 84 330 82
  [void](Add-Label $c1 'Installed version' 16 10 290 18 9 -color '#6B7280')
  [void](Add-Label $c1 $installed 16 28 290 32 16 -Bold)
  $c2 = Add-Box $script:Body 366 84 330 82
  [void](Add-Label $c2 'Update mode' 16 10 290 18 9 -color '#6B7280')
  $mode = Get-UpdateMode
  $state = @{ on = @('On', '#16A34A', 'Other apps are paused'); off = @('Off', '#D97706', 'Turn it on in the app before updating'); none = @('No workspace yet', '#6B7280', 'Nobody to pause') }[$mode]
  [void](Add-Label $c2 ([string][char]0x25CF) 14 30 22 30 13 -color $state[1])
  [void](Add-Label $c2 $state[0] 36 28 280 30 16 -Bold)
  [void](Add-Label $c2 $state[2] 16 58 300 18 9 -color '#6B7280')

  $drop = Add-Box $script:Body 24 182 672 230 '#F5F7FF' '#A5B4FC' -Dashed
  Enable-Drop $drop
  $big = Add-Label $drop ([string][char]0x2191) 0 26 672 40 22 -color '#4F46E5' -align 'MiddleCenter'
  $t1 = Add-Label $drop 'Drop the update package here' 0 72 672 28 13 -Bold -align 'MiddleCenter'
  $t2 = Add-Label $drop 'A SankyoChat-update-x.y.z.zip file or an unzipped folder' 0 100 672 22 9.5 -color '#4B5563' -align 'MiddleCenter'
  foreach ($l in @($big, $t1, $t2)) { Enable-Drop $l }
  [void](Add-Button $drop 'Choose zip...' 196 144 136 { Select-PackageGui -Zip })
  [void](Add-Button $drop 'Choose folder...' 340 144 136 { Select-PackageGui })

  [void](Add-Label $script:Body ($script:Check + '  Only app files are replaced. data\ and backup settings are never touched.') 24 426 672 22 9.5 -color '#15803D')

  $last = Get-LastUndo
  $undoText = 'Undo last update'
  if ($last) { $undoText = "Undo last update (back to $($last.Info.fromVersion))" }
  Set-Footer -left @(@{ Text = $undoText; Click = { Start-UndoGui }; Width = 260; Disabled = (-not $last) }) -right @(@{ Text = 'Close'; Click = { $script:Form.Close() } })
}

function Select-PackageGui([switch]$Zip) {
  if ($Zip) {
    $dlg = New-Object Windows.Forms.OpenFileDialog
    $dlg.Title = 'Choose the Sankyo Chat update package'
    $dlg.Filter = 'Update package (*.zip)|*.zip'
    if ($dlg.ShowDialog($script:Form) -eq 'OK') { Open-PackageGui $dlg.FileName }
  } else {
    $dlg = New-Object Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Choose the unzipped update folder (the one with sankyo-update.json in it).'
    if ($dlg.ShowDialog($script:Form) -eq 'OK') { Open-PackageGui $dlg.SelectedPath }
  }
}

function Open-PackageGui([string]$path) {
  if (-not $path) { return }
  $script:G.PkgPath = $path
  New-Screen
  $script:G.Screen = 'checking'
  [void](Add-Label $script:Body 'Checking the package...' 24 18 672 32 16 -Bold)
  [void](Add-Label $script:Body (Split-Path -Leaf $path) 24 54 672 20 9 -Mono -color '#6B7280')
  $script:Form.Cursor = 'WaitCursor'
  [Windows.Forms.Application]::DoEvents()
  try {
    if (-not (Test-CanWrite)) { throw "This Windows account can't change the app files in $AppDir. Run the updater as the super admin or IT." }
    $pkg = Open-Package $path
    $script:G.Pkg = $pkg
    if ($pkg.Problems.Count) { Show-Refused $pkg; return }
    $script:G.Plan = Get-Plan $pkg
    if ((Get-UpdateMode) -eq 'off' -and -not $SkipModeCheck) { Show-ModeOff } else { Show-Review }
  } catch {
    Show-Error $_.Exception.Message
    Show-Start
  } finally { $script:Form.Cursor = 'Default' }
}

function Show-Refused($pkg) {
  New-Screen
  $script:G.Screen = 'refused'
  Add-Icon ([string][char]0x2715) '#FEF2F2' '#FECACA' '#B91C1C'
  [void](Add-Label $script:Body "This package can't be used" 92 24 600 32 16 -Bold)
  [void](Add-Label $script:Body ("Nothing was changed. Sankyo Chat is still on {0}." -f (Get-InstalledVersion)) 92 56 600 22 9.5 -color '#374151')
  $box = Add-Box $script:Body 24 100 672 190 '#FFFFFF' '#FECACA'
  $hd = Add-Box $box 1 1 670 34 '#FEF2F2' '#FEF2F2'
  [void](Add-Label $hd 'What failed' 15 0 400 34 9.5 -Bold -color '#7F1D1D' -align 'MiddleLeft')
  $list = New-Object Windows.Forms.TextBox
  $list.Multiline = $true; $list.ReadOnly = $true; $list.ScrollBars = 'Vertical'; $list.BorderStyle = 'None'
  $list.BackColor = [Drawing.Color]::White; $list.Font = New-Object Drawing.Font('Consolas', 9.5)
  $list.SetBounds(16, 44, 644, 136)
  $list.Text = (@($pkg.Problems) -join "`r`n")
  $box.Controls.Add($list)
  [void](Add-Label $script:Body 'What to do' 24 306 672 22 10.5 -Bold)
  [void](Add-Label $script:Body 'Copy the zip again from where you got it, then choose it again. If it fails a second time, ask for a new package.' 24 330 672 44 9.5 -color '#374151')
  Set-Footer -left @(@{ Text = 'Open log'; Click = { Open-Log }; Width = 110 }) -right @(
    @{ Text = 'Close'; Click = { $script:Form.Close() } },
    @{ Text = 'Choose another package'; Click = { Show-Start }; Primary = $true; Width = 210 })
}

function Show-ModeOff([string]$hint = '') {
  New-Screen
  $script:G.Screen = 'modeoff'
  $pkg = $script:G.Pkg
  Add-VersionHeader (Get-InstalledVersion) $pkg.Version
  [void](Add-Banner 70 72 'warn' 'Turn on Update mode first' "People's apps are still reading and writing the share. Updating now could break their open app.")
  $steps = @(
    ('In Sankyo Chat, open Admin settings ' + $script:Arrow + ' Settings ' + $script:Arrow + ' Update the app'),
    'Click Start update and wait about 5 seconds',
    'Come back here and click Check again')
  for ($i = 0; $i -lt 3; $i++) {
    $y = 164 + $i * 40
    $n = Add-Box $script:Body 28 $y 26 26 '#FEF3C7' '#FEF3C7'
    [void](Add-Label $n ([string]($i + 1)) 0 0 26 26 9.5 -Bold -color '#78350F' -align 'MiddleCenter')
    [void](Add-Label $script:Body $steps[$i] 66 ($y + 2) 620 24 10.5)
  }
  if ($hint) { [void](Add-Label $script:Body $hint 24 290 672 22 9.5 -Bold -color '#B45309') }
  [void](Add-Label $script:Body ("Package ready: {0}, all {1} files checked. Nothing has been changed." -f $pkg.Name, @($pkg.Files).Count) 24 420 672 22 9.5 -color '#374151')
  Set-Footer -right @(
    @{ Text = 'Cancel'; Click = { Show-Start } },
    @{ Text = 'Check again'; Click = { if ((Get-UpdateMode) -eq 'off') { Show-ModeOff 'Still off. Click Start update in the app, wait 5 seconds, then try again.' } else { Show-Review } }; Primary = $true; Width = 130 })
}

function Show-Review {
  New-Screen
  $script:G.Screen = 'review'
  $pkg = $script:G.Pkg; $plan = $script:G.Plan
  Add-VersionHeader (Get-InstalledVersion) $pkg.Version $pkg.Name
  [void](Add-Banner 66 40 'ok' ("Package checked. All {0} files match their fingerprints." -f @($pkg.Files).Count) '')
  $notes = "$($pkg.Manifest.notes)"; if (-not $notes) { $notes = 'No notes in this package.' }
  [void](Add-Label $script:Body $notes 24 114 672 40 9.5 -color '#374151')

  $c = Add-Box $script:Body 24 158 330 200
  [void](Add-Label $c 'App files that change' 16 10 300 22 10.5 -Bold)
  $sample = { param($list) $s = (@($list) | Select-Object -First 2) -join ', '; if (@($list).Count -gt 2) { $s += ', ...' }; $s }
  $rows = @(
    @('Replace', $plan.Replace, '#3730A3'),
    @('Add', $plan.Add, '#15803D'),
    @('Remove', $plan.Remove, '#B91C1C'),
    @('Same', $plan.Same, '#6B7280'))
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $y = 40 + $i * 30
    [void](Add-Label $c ([string]@($rows[$i][1]).Count) 8 $y 34 22 10.5 -Bold -align 'TopRight')
    [void](Add-Label $c $rows[$i][0] 48 $y 66 22 9.5 -Bold -color $rows[$i][2])
    $txt = & $sample $rows[$i][1]
    if ($rows[$i][0] -eq 'Same') { $txt = 'already up to date' }
    [void](Add-Label $c $txt 116 ($y + 2) 206 20 8.5 -Mono -color '#4B5563')
  }
  $lnk = New-Object Windows.Forms.LinkLabel
  $lnk.Text = 'Show all files'; $lnk.SetBounds(16, 166, 200, 22); $lnk.LinkColor = (Col '#4F46E5')
  $lnk.Add_LinkClicked({ Show-FileList })
  $c.Controls.Add($lnk)

  $p = Add-Box $script:Body 366 158 330 200 '#F9FAFB'
  [void](Add-Label $p ($script:Check + '  Not touched') 16 10 300 22 10.5 -Bold -color '#15803D')
  $prot = @(Get-ProtectedList)
  [void](Add-Label $p (($prot | Select-Object -First 5) -join "`n") 16 40 300 110 9 -Mono -color '#374151')
  [void](Add-Label $p 'and anything else not listed as an app file' 16 166 300 20 8.5 -color '#6B7280')

  $cb = New-Object Windows.Forms.CheckBox
  $cb.SetBounds(24, 372, 672, 30)
  $cb.Font = New-Object Drawing.Font('Segoe UI', 10)
  if (Test-BackupAvailable) { $cb.Text = 'Back up data\ before updating (recommended)'; $cb.Checked = $true }
  else { $cb.Text = 'Back up data\ first  (not set up on this PC: run backup\1 Set up hourly backup.bat)'; $cb.Checked = $false; $cb.Enabled = $false }
  $script:Body.Controls.Add($cb)
  $script:G.BackupBox = $cb

  Set-Footer -note 'The old version is kept so you can undo.' -right @(
    @{ Text = 'Cancel'; Click = { Show-Start } },
    @{ Text = 'Install update'; Click = { Start-InstallGui }; Primary = $true; Width = 140 })
}

function Show-FileList {
  $plan = $script:G.Plan
  $lines = @()
  foreach ($r in $plan.Replace) { $lines += "replace  $r" }
  foreach ($r in $plan.Add)     { $lines += "add      $r" }
  foreach ($r in $plan.Remove)  { $lines += "remove   $r" }
  foreach ($r in $plan.Same)    { $lines += "same     $r" }
  $f = New-Object Windows.Forms.Form
  $f.Text = 'Files in this update'; $f.ClientSize = New-Object Drawing.Size(520, 420); $f.StartPosition = 'CenterParent'
  $f.MinimizeBox = $false; $f.MaximizeBox = $false; $f.FormBorderStyle = 'FixedDialog'
  $t = New-Object Windows.Forms.TextBox
  $t.Multiline = $true; $t.ReadOnly = $true; $t.ScrollBars = 'Vertical'; $t.Dock = 'Fill'
  $t.Font = New-Object Drawing.Font('Consolas', 10); $t.Text = ($lines -join "`r`n")
  $f.Controls.Add($t)
  [void]$f.ShowDialog($script:Form)
}

function Show-Installing([bool]$withBackup) {
  New-Screen
  $script:G.Screen = 'installing'
  [void](Add-Label $script:Body ("Installing {0}..." -f $script:G.Pkg.Version) 24 16 672 32 16 -Bold)
  [void](Add-Label $script:Body "Don't close this window. Other apps stay paused until you finish in the app." 24 50 672 22 9.5 -color '#6B7280')
  $script:G.Status = Add-Label $script:Body 'Starting' 24 90 500 22 9.5
  $script:G.Count = Add-Label $script:Body '' 520 90 176 22 9.5 -color '#6B7280' -align 'TopRight'
  $track = Add-Box $script:Body 24 114 672 8 '#E5E7EB' '#E5E7EB'
  $fill = New-Object Windows.Forms.Panel
  $fill.SetBounds(0, 0, 0, 8); $fill.BackColor = (Col '#4F46E5')
  $track.Controls.Add($fill); $script:G.Bar = $fill

  $defs = @()
  if ($withBackup) { $defs += , @('backup', 'Back up data\') }
  $defs += , @('keep', ("Keep a copy of {0} in _updates\" -f (Get-InstalledVersion)))
  $defs += , @('replace', 'Replace app files')
  $defs += , @('verify', 'Check the new files')
  $defs += , @('data', 'Check data\ is unchanged')
  $script:G.Steps = @{}
  $y = 146
  foreach ($d in $defs) {
    $dot = Add-Label $script:Body ([string][char]0x25CB) 24 $y 26 26 12 -color '#9CA3AF' -align 'MiddleCenter'
    $txt = Add-Label $script:Body $d[1] 58 $y 600 26 10.5 -color '#6B7280' -align 'MiddleLeft'
    $script:G.Steps[$d[0]] = @{ Dot = $dot; Text = $txt }
    $y += 36
  }
  [void](Add-Label $script:Body ("If anything goes wrong, the updater puts {0} back by itself." -f (Get-InstalledVersion)) 24 420 672 22 9.5 -color '#15803D')
  Set-Footer -note 'Usually takes under a minute.'
  [Windows.Forms.Application]::DoEvents()
}

function Set-StepGui([string]$step, [string]$state, [string]$detail, [int]$done, [int]$total) {
  $s = $script:G.Steps[$step]
  if (-not $s) { return }
  switch ($state) {
    'run'  { $s.Dot.Text = [string][char]0x25CF; $s.Dot.ForeColor = (Col '#4F46E5'); $s.Text.ForeColor = (Col '#111827'); $s.Text.Font = New-Object Drawing.Font('Segoe UI', 10.5, [Drawing.FontStyle]::Bold)
             $script:G.Status.Text = $s.Text.Text }
    'done' { $s.Dot.Text = $script:Check; $s.Dot.ForeColor = (Col '#16A34A'); $s.Text.ForeColor = (Col '#111827'); $s.Text.Font = New-Object Drawing.Font('Segoe UI', 10.5) }
    'fail' { $s.Dot.Text = [string][char]0x2715; $s.Dot.ForeColor = (Col '#B91C1C'); $s.Text.ForeColor = (Col '#B91C1C') }
  }
  if ($step -eq 'replace' -and $total -gt 0) {
    $script:G.Bar.Width = [math]::Min(672, [int](672 * $done / $total))
    $script:G.Count.Text = "$done of $total"
    if ($detail) { $script:G.Status.Text = "Replace app files   $detail" }
  }
  if ($step -eq 'verify' -and $state -eq 'done') { $script:G.Count.Text = '' }
  [Windows.Forms.Application]::DoEvents()
}

function Start-InstallGui {
  $withBackup = [bool]($script:G.BackupBox -and $script:G.BackupBox.Checked)
  try { Enter-Lock } catch {
    $ans = [Windows.Forms.MessageBox]::Show($script:Form, ($_.Exception.Message + "`n`nIf you're sure no other updater is open, click Yes to go on anyway."), 'Sankyo Chat Updater', 'YesNo', 'Warning')
    if ($ans -ne 'Yes') { return }
    Enter-Lock -Force
  }
  $script:G.Busy = $true
  $result = $null
  try {
    Write-WorkReadme
    Show-Installing $withBackup
    $script:Progress = { param($step, $state, $detail, $done, $total) Set-StepGui $step $state $detail $done $total }
    if ($withBackup) {
      Report 'backup' 'run'
      $code = Invoke-DataBackup
      Write-Log "  Data backup before update: exit code $code"
      if ($code -ne 0) {
        Report 'backup' 'fail'
        $ans = [Windows.Forms.MessageBox]::Show($script:Form, "The data backup didn't finish (see the backup log in your backup folder).`n`nUpdate anyway? The updater never touches data\.", 'Sankyo Chat Updater', 'YesNo', 'Warning')
        if ($ans -ne 'Yes') { $script:G.Busy = $false; Exit-Lock; $script:Progress = $null; Show-Review; return }
      } else { Report 'backup' 'done' }
    }
    $result = Invoke-Install $script:G.Pkg $script:G.Plan
  } catch {
    $script:G.Busy = $false; $script:Progress = $null; Exit-Lock
    Show-Error $_.Exception.Message
    Show-Start
    return
  }
  $script:Progress = $null
  $script:G.Busy = $false
  Exit-Lock
  if ($result.Ok) { Show-Done $result } else { Show-RolledBack $result }
}

function Show-Done($r) {
  New-Screen
  $script:G.Screen = 'done'
  $script:G.LastResult = $r
  Add-Icon $script:Check '#F0FDF4' '#BBF7D0' '#15803D'
  [void](Add-Label $script:Body ("Sankyo Chat {0} is installed" -f $r.To) 92 24 600 32 16 -Bold)
  [void](Add-Label $script:Body ("All {0} files checked. data\ is unchanged." -f $r.Checked) 92 56 600 22 9.5 -color '#374151')
  Add-NextSteps 104 $r.To $true
  [void](Add-Label $script:Body ("{0} is kept in _updates\{1} if you need to undo." -f $r.From, (Split-Path -Leaf $r.CopyDir)) 24 330 672 40 9.5 -color '#374151')
  Set-Footer -left @(@{ Text = 'Open log'; Click = { Open-Log }; Width = 110 }, @{ Text = 'Undo this update'; Click = { Start-UndoGui }; Width = 170 }) -right @(
    @{ Text = 'Close'; Click = { $script:Form.Close() }; Primary = $true })
}

function Add-NextSteps([int]$y, [string]$version, [bool]$fingerprint) {
  $h = 112; if ($fingerprint) { $h = 196 }
  $box = Add-Box $script:Body 24 $y 672 $h '#F5F7FF' '#C7D2FE'
  [void](Add-Label $box 'Left to do, in Sankyo Chat' 20 14 600 24 11 -Bold)
  $items = @(, @('Click Finish update in the red banner', "Everyone's app reloads with $version."))
  if ($fingerprint) { $items += , @('Save the new trusted fingerprint', ('Admin settings ' + $script:Arrow + ' App files ' + $script:Arrow + ' Check app files ' + $script:Arrow + ' Save as trusted fingerprint')) }
  for ($i = 0; $i -lt $items.Count; $i++) {
    $iy = 50 + $i * 72
    $n = Add-Box $box 20 $iy 28 28 '#EEF2FF' '#C7D2FE'
    [void](Add-Label $n ([string]($i + 1)) 0 0 28 28 10 -Bold -color '#3730A3' -align 'MiddleCenter')
    [void](Add-Label $box $items[$i][0] 62 ($iy + 2) 590 22 10.5 -Bold)
    [void](Add-Label $box $items[$i][1] 62 ($iy + 24) 590 22 9.5 -color '#374151')
  }
}

function Show-RolledBack($r) {
  New-Screen
  $script:G.Screen = 'rolledback'
  $bad = ($r.RestoreFailed.Count -gt 0)
  if ($bad) { Add-Icon '!' '#FEF2F2' '#FECACA' '#B91C1C' } else { Add-Icon ([string][char]0x21BA) '#FFFBEB' '#FDE68A' '#B45309' }
  [void](Add-Label $script:Body 'The update was undone' 92 24 600 32 16 -Bold)
  if ($bad) { [void](Add-Label $script:Body 'Some old files could not be put back. Sankyo Chat may not open.' 92 56 600 22 9.5 -Bold -color '#B91C1C') }
  else { [void](Add-Label $script:Body ("Sankyo Chat is back on {0} and works as before." -f $r.From) 92 56 600 22 9.5 -color '#374151') }
  $box = Add-Box $script:Body 24 100 672 130
  [void](Add-Label $box ('Why: ' + $r.Reason) 16 12 640 44 9.5)
  if ($bad) {
    [void](Add-Label $box ("Copy these from _updates\{0}\files by hand:  {1}" -f (Split-Path -Leaf $r.CopyDir), (($r.RestoreFailed | Select-Object -First 3) -join '; ')) 16 60 640 60 9 -color '#B91C1C')
  } else {
    [void](Add-Label $box ($script:Check + "  All $($r.From) files put back and checked") 16 62 640 22 10 -color '#15803D')
    [void](Add-Label $box ($script:Check + '  data\ was not touched') 16 90 640 22 10 -color '#15803D')
  }
  [void](Add-Label $script:Body 'What to do' 24 246 672 22 10.5 -Bold)
  [void](Add-Label $script:Body ("Update mode is still on. Try again now, or click Finish update in the app to let everyone back in on {0}.`nIf it fails twice, send _updates\update-log.txt to whoever made the package." -f $r.From) 24 270 672 60 9.5 -color '#374151')
  Set-Footer -left @(@{ Text = 'Open log'; Click = { Open-Log }; Width = 110 }) -right @(
    @{ Text = 'Close'; Click = { $script:Form.Close() } },
    @{ Text = 'Try again'; Click = { Open-PackageGui $script:G.PkgPath }; Primary = $true; Width = 120 })
}

function Start-UndoGui {
  $last = Get-LastUndo
  if (-not $last) { [void][Windows.Forms.MessageBox]::Show($script:Form, 'There is no update to undo.', 'Sankyo Chat Updater', 'OK', 'Information'); return }
  if (-not (Test-CanWrite)) { Show-Error "This Windows account can't change the app files in $AppDir. Run the updater as the super admin or IT."; return }
  if ((Get-UpdateMode) -eq 'off' -and -not $SkipModeCheck) {
    [void][Windows.Forms.MessageBox]::Show($script:Form, ("Turn on Update mode first.`n`nIn Sankyo Chat: Admin settings {0} Settings {0} Update the app {0} Start update. Wait 5 seconds, then click Undo again." -f $script:Arrow), 'Sankyo Chat Updater', 'OK', 'Warning')
    return
  }
  $msg = "Put back {0}?`n`nThis undoes the update to {1} made on {2}. data\ is not touched." -f $last.Info.fromVersion, $last.Info.toVersion, $last.Info.ts
  if ([Windows.Forms.MessageBox]::Show($script:Form, $msg, 'Undo last update', 'YesNo', 'Question') -ne 'Yes') { return }
  try { Enter-Lock } catch { Show-Error $_.Exception.Message; return }
  $script:G.Busy = $true
  $script:Form.Cursor = 'WaitCursor'
  try { $failed = @(Invoke-Undo $last) } catch { $failed = @($_.Exception.Message) }
  finally { $script:Form.Cursor = 'Default'; $script:G.Busy = $false; Exit-Lock }

  New-Screen
  $script:G.Screen = 'undone'
  if ($failed.Count) {
    Add-Icon '!' '#FEF2F2' '#FECACA' '#B91C1C'
    [void](Add-Label $script:Body 'Undo did not finish' 92 24 600 32 16 -Bold)
    [void](Add-Label $script:Body ("Copy these from {0}\files by hand:`n{1}" -f $last.Dir, (($failed | Select-Object -First 5) -join "`n")) 24 100 672 200 9.5 -color '#B91C1C')
  } else {
    Add-Icon ([string][char]0x21BA) '#F0FDF4' '#BBF7D0' '#15803D'
    [void](Add-Label $script:Body ("Sankyo Chat is back on {0}" -f $last.Info.fromVersion) 92 24 600 32 16 -Bold)
    [void](Add-Label $script:Body 'All old files put back and checked. data\ was not touched.' 92 56 600 22 9.5 -color '#374151')
    Add-NextSteps 104 $last.Info.fromVersion $false
  }
  Set-Footer -left @(@{ Text = 'Open log'; Click = { Open-Log }; Width = 110 }) -right @(@{ Text = 'Close'; Click = { $script:Form.Close() }; Primary = $true })
}

# ================================================================ app button

# The app's "Open the updater" button is a sankyo-update: link. This registers that link type for the
# current Windows account only (HKCU, no admin rights). The command starts this script with no
# arguments: the link's text is never passed on, so a web page can at most open the updater window.
$LinkKey = 'HKCU:\Software\Classes\sankyo-update'

function Invoke-RegisterLink {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $ScriptDir 'SankyoUpdate.ps1'
  $cmd = '"{0}" -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{1}"' -f $ps, $script
  New-Item -Path $LinkKey -Force | Out-Null
  Set-ItemProperty -Path $LinkKey -Name '(default)' -Value 'URL:Sankyo Chat Updater'
  Set-ItemProperty -Path $LinkKey -Name 'URL Protocol' -Value ''
  New-Item -Path "$LinkKey\shell\open\command" -Force | Out-Null
  Set-ItemProperty -Path "$LinkKey\shell\open\command" -Name '(default)' -Value $cmd
  Write-Log "Updater button set up for $env:USERNAME on $env:COMPUTERNAME ($script)"
  Write-Host ''
  Write-Host 'Done. The "Open the updater" button in Sankyo Chat now opens:' -ForegroundColor Green
  Write-Host "  $script"
  Write-Host ''
  Write-Host 'The first time you click it, the browser asks to open Windows PowerShell.'
  Write-Host 'Tick "Always allow" and click Open.'
  Write-Host ''
  Write-Host 'If the SankyoChat folder moves, run this again from the new place.'
  return 0
}

function Invoke-UnregisterLink {
  if (Test-Path -Path $LinkKey) { Remove-Item -Path $LinkKey -Recurse -Force }
  Write-Log "Updater button removed for $env:USERNAME on $env:COMPUTERNAME"
  Write-Host 'Done. The "Open the updater" button no longer opens anything on this PC.' -ForegroundColor Green
  Write-Host 'You can still run update\Update Sankyo Chat.bat directly.'
  return 0
}

# ================================================================ main

try {
  if ($RegisterLink) { exit ([int](Invoke-RegisterLink | Select-Object -Last 1)) }
  if ($UnregisterLink) { exit ([int](Invoke-UnregisterLink | Select-Object -Last 1)) }
  if ($NoGui) { exit ([int](Invoke-Console | Select-Object -Last 1)) }
  if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'js\version.js'))) { throw "$AppDir doesn't look like the Sankyo Chat folder. Keep the update folder inside SankyoChat." }
  Start-Gui
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Exit-Lock
  if ($NoGui) { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Sankyo Chat Updater', 'OK', 'Error')
  } catch { }
  exit 1
}
