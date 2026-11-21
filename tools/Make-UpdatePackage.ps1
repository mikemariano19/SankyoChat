<#
  Sankyo Chat - make an update package (run on the developer PC, not in the office)
  -------------------------------------------------------------------------------
  Builds dist\SankyoChat-update-<version>.zip from the app files in this folder:
  the files git tracks (or, without git, the files on disk) that are on the updater's
  allowlist. data\ is never packaged, apart from data\README.txt.

    tools\Make update package.bat
    Make-UpdatePackage.ps1 [-Notes "What changed"] [-MinFrom 1.9.0] [-Out dist] [-Force]

  Before you run it: raise APP_VERSION in js\version.js (and add a NEWS entry in js\chat.js).
  It refuses to build a version that isn't newer than the newest package in dist\ unless -Force.

  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
[CmdletBinding()]
param(
  [string]$Notes = '',
  [string]$MinFrom = '1.9.0',
  [string]$Out = '',
  [switch]$Force,
  [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'
$RepoDir = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
if (-not $Out) { $Out = Join-Path $RepoDir 'dist' }

# same allowlist as update\SankyoUpdate.ps1
function Test-Allowed([string]$lower) {
  if (@('index.html', 'check.html', 'readme.md', 'data/readme.txt') -contains $lower) { return $true }
  if ($lower -match '^(css|js|assets)/.+') { return $true }
  if ($lower -match '^(backup|update)/[^/]+\.(ps1|bat)$') { return $true }
  return $false
}

try {
  $versionJs = Join-Path $RepoDir 'js\version.js'
  $m = [regex]::Match((Get-Content -LiteralPath $versionJs -Raw -Encoding UTF8), "APP_VERSION\s*=\s*['""]([^'""]+)['""]")
  if (-not $m.Success) { throw "APP_VERSION not found in $versionJs." }
  $version = $m.Groups[1].Value
  $v = $null
  if (-not [version]::TryParse($version, [ref]$v)) { throw "APP_VERSION '$version' is not a version like 1.13.0." }

  # never build the same or an older version twice
  if (Test-Path -LiteralPath $Out) {
    foreach ($z in (Get-ChildItem -LiteralPath $Out -Filter 'SankyoChat-update-*.zip')) {
      $zm = [regex]::Match($z.BaseName, '^SankyoChat-update-(.+)$')
      $zv = $null
      if ($zm.Success -and [version]::TryParse($zm.Groups[1].Value, [ref]$zv) -and $zv -ge $v -and -not $Force) {
        throw "dist already has $($z.Name). Raise APP_VERSION in js\version.js first (it is $version), or use -Force."
      }
    }
  }

  # which files
  $rels = @()
  $useGit = (Test-Path -LiteralPath (Join-Path $RepoDir '.git')) -and (Get-Command git.exe -ErrorAction SilentlyContinue)
  if ($useGit) {
    $rels = @(& git.exe -C $RepoDir ls-files) | ForEach-Object { $_.Trim('"') }
    $dirty = @(& git.exe -C $RepoDir status --porcelain) | Where-Object { $_ }
    if ($dirty.Count) { Write-Host "Note: there are uncommitted changes. The package uses the files as they are on disk now." -ForegroundColor Yellow }
  } else {
    $root = $RepoDir.TrimEnd('\') + '\'
    $rels = Get-ChildItem -LiteralPath $RepoDir -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($root.Length).Replace('\', '/') }
  }
  $rels = @($rels | Where-Object { (Test-Allowed $_.ToLowerInvariant()) -and (Test-Path -LiteralPath (Join-Path $RepoDir $_.Replace('/', '\')) -PathType Leaf) } | Sort-Object)
  if (-not ($rels -contains 'index.html') -or -not ($rels -contains 'js/version.js')) { throw 'index.html or js/version.js is missing from the file list.' }

  if (-not $Notes -and -not $NoPrompt) { $Notes = Read-Host "One line about what's new in $version (shown before installing; Enter to skip)" }

  $files = foreach ($rel in $rels) {
    $full = Join-Path $RepoDir $rel.Replace('/', '\')
    [ordered]@{ path = $rel; size = (Get-Item -LiteralPath $full).Length; sha256 = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  $manifest = [ordered]@{
    app            = 'SankyoChat'
    version        = $version
    minFromVersion = $MinFrom
    built          = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    notes          = $Notes
    files          = @($files)
  }

  if (-not (Test-Path -LiteralPath $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
  $zipPath = Join-Path $Out "SankyoChat-update-$version.zip"
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $entry = $zip.CreateEntry('sankyo-update.json')
    $w = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding $false))
    try { $w.Write(($manifest | ConvertTo-Json -Depth 6)) } finally { $w.Dispose() }
    foreach ($rel in $rels) {
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $RepoDir $rel.Replace('/', '\')), $rel)
    }
  } finally { $zip.Dispose() }

  Write-Host ''
  Write-Host ("Made {0}" -f $zipPath) -ForegroundColor Green
  Write-Host ("  version {0}, {1} files, {2:N0} KB" -f $version, $rels.Count, ((Get-Item -LiteralPath $zipPath).Length / 1KB))
  Write-Host '  Copy it to the office, then run update\Update Sankyo Chat.bat there.'
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
