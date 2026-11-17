$ErrorActionPreference = 'Stop'

function Read-SecretValue {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  $secureValue = Read-Host -AsSecureString -Prompt $Prompt
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Install Python 3.11 or newer from python.org and enable the Python launcher, then run this script again.'
  }
  python -m venv (Join-Path $projectRoot '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the companion Python environment.' }
  $python = Join-Path $projectRoot '.venv\Scripts\python.exe'
  & $python -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare pip.' }
  & $python -m pip install -r (Join-Path $projectRoot 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Unable to install the Windows companion requirements.' }
}

$env:NERV_RELAY_URL = Read-Host 'Cloudflare relay HTTPS origin'
$env:NERV_RELAY_DEVICE_ID = Read-Host 'Configured relay device ID'
$env:NERV_PAIRING_TOKEN = Read-SecretValue 'Pairing code (must match Cloudflare PAIRING_CODE)'
$env:NERV_RELAY_DEVICE_TOKEN = Read-SecretValue 'Device token (must match Cloudflare DEVICE_TOKEN)'

if ($env:NERV_PAIRING_TOKEN.Length -lt 16) {
  throw 'Pairing code must contain at least 16 characters.'
}
if (-not $env:NERV_RELAY_URL.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The relay URL must use HTTPS.'
}
if ([string]::IsNullOrWhiteSpace($env:NERV_RELAY_DEVICE_ID) -or [string]::IsNullOrWhiteSpace($env:NERV_RELAY_DEVICE_TOKEN)) {
  throw 'Relay device ID and device token are required.'
}

try {
  Set-Location $projectRoot
  & $python -m windows_companion.server
  if ($LASTEXITCODE -ne 0) { throw 'LOQ Link exited with an error.' }
} finally {
  Remove-Item Env:NERV_PAIRING_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:NERV_RELAY_DEVICE_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:NERV_RELAY_URL -ErrorAction SilentlyContinue
  Remove-Item Env:NERV_RELAY_DEVICE_ID -ErrorAction SilentlyContinue
}
