[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA 'GeminiVideoWatermarkCleaner'
$DesktopDir = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopDir 'Gemini Video Watermark Cleaner.lnk'

function Write-Step([string]$Message) {
  Write-Host "[Installer] $Message" -ForegroundColor Cyan
}

function Ensure-Gh {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    Write-Step 'GitHub CLI detected.'
    return
  }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI is missing and winget is unavailable. Install GitHub CLI from https://cli.github.com/ and run this installer again.'
  }

  Write-Step 'GitHub CLI not found. Installing with winget...'
  & winget install --id GitHub.cli --exact --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not install GitHub CLI (exit $LASTEXITCODE)."
  }

  $candidate = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
  if (Test-Path $candidate) {
    $env:Path = "$env:Path;$([IO.Path]::GetDirectoryName($candidate))"
  }

  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI was installed but is not visible in this PowerShell session. Close/reopen PowerShell, then run this installer again.'
  }
}

function Ensure-GhAuth {
  & gh auth status --hostname github.com *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Step 'Opening GitHub browser authentication; the device code will be copied to your clipboard.'
    & gh auth login --hostname github.com --git-protocol https --web --clipboard --scopes codespace,repo
    if ($LASTEXITCODE -ne 0) {
      throw 'GitHub CLI authentication did not complete successfully.'
    }
  } else {
    Write-Step 'GitHub CLI authentication detected.'
  }

  Write-Step 'Ensuring Codespaces permission is granted to GitHub CLI...'
  & gh auth refresh --hostname github.com --scopes codespace
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not grant the GitHub CLI codespace scope.'
  }
}

function Install-LauncherFiles {
  Write-Step "Installing launcher files to $InstallDir"
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

  foreach ($name in @('GeminiCleaner.ps1', 'GeminiCleaner.cmd')) {
    $source = Join-Path $SourceDir $name
    if (-not (Test-Path $source)) {
      throw "Required launcher file not found: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $InstallDir $name) -Force
  }
}

function Install-Shortcut {
  Write-Step 'Creating Desktop shortcut...'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = Join-Path $InstallDir 'GeminiCleaner.cmd'
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Description = 'Start the private GitHub Codespace and open Gemini Video Watermark Cleaner.'
  $shortcut.WindowStyle = 1
  $shortcut.Save()
}

try {
  Ensure-Gh
  Ensure-GhAuth
  Install-LauncherFiles
  Install-Shortcut

  Write-Host ''
  Write-Host 'Installation complete.' -ForegroundColor Green
  Write-Host "Shortcut: $ShortcutPath"
  Write-Host 'Double-click the shortcut whenever you want to use the private cleaner.'
} catch {
  Write-Host ''
  Write-Host 'Installation failed:' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 1
}
