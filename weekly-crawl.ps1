# Weekly learnings cron.
# Triggered by Windows Task Scheduler (Friday 19:30 local).
# Runs both crawlers directly (no dependency on the server being up).

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
$logDir = Join-Path $here "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$log = Join-Path $logDir "weekly-$stamp.log"

"=== weekly crawl $stamp ===" | Out-File $log -Encoding utf8

$node = (Get-Command node).Source
"node: $node" | Out-File $log -Append -Encoding utf8

foreach ($script in @("crawl-wa.mjs", "crawl-sessions.mjs")) {
  "--- $script ---" | Out-File $log -Append -Encoding utf8
  $proc = Start-Process -FilePath $node -ArgumentList @($script) -WorkingDirectory $here `
    -RedirectStandardOutput "$log.tmp.out" -RedirectStandardError "$log.tmp.err" `
    -NoNewWindow -Wait -PassThru
  if (Test-Path "$log.tmp.out") { Get-Content "$log.tmp.out" | Out-File $log -Append -Encoding utf8; Remove-Item "$log.tmp.out" }
  if (Test-Path "$log.tmp.err") { Get-Content "$log.tmp.err" | Out-File $log -Append -Encoding utf8; Remove-Item "$log.tmp.err" }
  "exit: $($proc.ExitCode)" | Out-File $log -Append -Encoding utf8
}

"=== done ===" | Out-File $log -Append -Encoding utf8
