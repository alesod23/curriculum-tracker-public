# Curriculum tracker launcher.
#
# - Frees port 4117 if anything is already on it
# - Starts the node server in the background (detached from this PowerShell)
# - Prints the URL
#
# Run on demand:  ./start.ps1
# Stop later:     Stop-Process -Id <pid>  (the launcher prints the pid)

$ErrorActionPreference = "SilentlyContinue"

$port = 4117
$serverScript = Join-Path $PSScriptRoot "server.mjs"

# Kill anything already listening on the port.
$existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($existing) {
  $existing | ForEach-Object {
    try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Milliseconds 300
}

# Launch detached so closing this terminal does not kill the server.
$node = (Get-Command node).Source
$proc = Start-Process -FilePath $node -ArgumentList @($serverScript) -WindowStyle Hidden -PassThru

Write-Host ""
Write-Host "Curriculum tracker:  localhost:$port"
Write-Host "Process id:          $($proc.Id)"
Write-Host "Stop with:           Stop-Process -Id $($proc.Id)"
Write-Host ""
