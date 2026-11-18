$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = "C:\Users\sahit\AppData\Local\Programs\Python\Python311\python.exe"

if (-not (Test-Path $python)) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) {
    $python = $cmd.Source
  } else {
    throw "Python executable not found. Ensure Python 3.11 is installed."
  }
}

$port = 8000
$env:NERV_COMPANION_HOST = "0.0.0.0"
$env:NERV_COMPANION_PORT = "$port"
$env:NERV_ALLOW_INSECURE_LAN = "1"
$env:NERV_ALLOWED_ORIGINS = "*"

# Default or prompt pairing token
$defaultPairing = "1234"
$token = Read-Host "Enter Pairing Code (press Enter for default: '$defaultPairing')"
if ([string]::IsNullOrWhiteSpace($token)) {
  $token = $defaultPairing
}
$env:NERV_PAIRING_TOKEN = $token

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
if (-not $ip) {
  $ip = "192.168.1.23"
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  NERV LOQ Companion starting on LAN!" -ForegroundColor Cyan
Write-Host "  Open on your mobile phone / browser at:" -ForegroundColor Yellow
Write-Host "  👉 http://${ip}:${port}/" -ForegroundColor Green
Write-Host "  Pairing Code: $token" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

try {
  Set-Location $projectRoot
  & $python -m windows_companion.server
} finally {
  Remove-Item Env:NERV_PAIRING_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:NERV_COMPANION_HOST -ErrorAction SilentlyContinue
  Remove-Item Env:NERV_ALLOW_INSECURE_LAN -ErrorAction SilentlyContinue
  Remove-Item Env:NERV_ALLOWED_ORIGINS -ErrorAction SilentlyContinue
}
