[CmdletBinding()]
param(
  [string]$Repository = 'dhvu1990/gemini-video-watermark-cleaner',
  [int]$Port = 5173,
  [int]$StartTimeoutSeconds = 180,
  [int]$PortTimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "[Gemini Cleaner] $Message" -ForegroundColor Cyan
}

function Invoke-GhText([string[]]$Arguments) {
  $output = & gh @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw (($output | ForEach-Object { [string]$_ }) -join "`n")
  }
  return (($output | ForEach-Object { [string]$_ }) -join "`n")
}

function Invoke-GhJson([string[]]$Arguments) {
  $text = Invoke-GhText $Arguments
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return $text | ConvertFrom-Json
}

function Get-TargetCodespace {
  $items = Invoke-GhJson @(
    'codespace', 'list',
    '--repo', $Repository,
    '--limit', '30',
    '--json', 'name,state,lastUsedAt'
  )

  if (-not $items) {
    throw "No Codespace found for $Repository. Create one once from GitHub Codespaces, then run this launcher again."
  }

  return @($items) |
    Sort-Object { [DateTimeOffset]::Parse($_.lastUsedAt) } -Descending |
    Select-Object -First 1
}

function Get-CodespaceState([string]$Name) {
  return (Invoke-GhText @('api', "/user/codespaces/$Name", '--jq', '.state')).Trim()
}

function Wait-CodespaceAvailable([string]$Name) {
  $deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
  do {
    $state = Get-CodespaceState $Name
    Write-Step "Codespace state: $state"
    if ($state -eq 'Available') { return }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)

  throw "Codespace did not become Available within $StartTimeoutSeconds seconds."
}

function Get-PrivatePortUrl([string]$Name) {
  $deadline = (Get-Date).AddSeconds($PortTimeoutSeconds)

  do {
    $ports = Invoke-GhJson @(
      'codespace', 'ports',
      '--codespace', $Name,
      '--json', 'browseUrl,sourcePort,visibility'
    )

    $entry = @($ports) |
      Where-Object { [int]$_.sourcePort -eq $Port } |
      Select-Object -First 1

    if ($entry) {
      if ([string]$entry.visibility -ne 'private') {
        Write-Step "Port $Port is not private. Applying private visibility..."
        Invoke-GhText @(
          'codespace', 'ports', 'visibility',
          ("{0}:private" -f $Port),
          '--codespace', $Name
        ) | Out-Null
        Start-Sleep -Seconds 2
        continue
      }

      if (-not [string]::IsNullOrWhiteSpace([string]$entry.browseUrl)) {
        return [string]$entry.browseUrl
      }
    }

    Write-Step "Waiting for private forwarded port $Port..."
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)

  throw "Private forwarded port $Port did not become available within $PortTimeoutSeconds seconds."
}

try {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) is not installed. Run the installer package first.'
  }

  & gh auth status --hostname github.com *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'GitHub CLI is not authenticated. Run: gh auth login --hostname github.com --web'
  }

  $codespace = Get-TargetCodespace
  $name = [string]$codespace.name
  $state = [string]$codespace.state

  Write-Step "Using Codespace: $name"
  Write-Step "Current state: $state"

  if ($state -notin @('Available', 'Starting')) {
    Write-Step 'Starting Codespace...'
    try {
      Invoke-GhText @('api', '--method', 'POST', "/user/codespaces/$name/start") | Out-Null
    } catch {
      Write-Step "Start request returned: $($_.Exception.Message)"
      Write-Step 'Continuing to poll state in case GitHub already started it.'
    }
  }

  Wait-CodespaceAvailable $name
  $url = Get-PrivatePortUrl $name

  Write-Step "Opening private tool: $url"
  Start-Process $url
  Start-Sleep -Milliseconds 800
} catch {
  Write-Host ''
  Write-Host "Gemini Cleaner launcher failed:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Opening GitHub Codespaces so you can inspect the current state.' -ForegroundColor DarkGray
  Start-Process 'https://github.com/codespaces'
  Read-Host 'Press Enter to close'
  exit 1
}
