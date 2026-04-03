# Manual toast smoke test.
# Run: powershell -EP Bypass -File scripts/manual/test-toast.ps1
#
# Coverage:
#   1. Mimic the cli.js -> notify.ps1 handoff through env vars.
#   2. Exercise three hook types with and without HWND.
#   3. Pause between cases so the result is easy to inspect by eye.

$packageRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$notifyScript   = Join-Path $packageRoot "scripts\notify.ps1"
$findHwndScript = Join-Path $packageRoot "scripts\find-hwnd.ps1"
$logFile        = Join-Path $env:TEMP "ai-agent-notify-test.log"

# Reuse the current terminal window when possible.
$findResult = & powershell.exe -NoProfile -EP Bypass -File $findHwndScript -StartPid $PID 2>$null
$hwnd = [int]($findResult | Select-Object -Last 1)
if ($hwnd -eq 0) {
    Write-Host "Warning: current window HWND not found, with-hwnd cases will behave like no-hwnd" -ForegroundColor Yellow
}
Write-Host "Using HWND: $hwnd (current window)" -ForegroundColor DarkGray

function Send-Toast([string]$eventName, [string]$testHwnd = '', [string]$title = '') {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName              = 'powershell.exe'
    $psi.Arguments             = "-NoProfile -EP Bypass -File `"$notifyScript`""
    $psi.UseShellExecute       = $false
    $psi.RedirectStandardError = $true

    # Keep this aligned with the env vars emitted by cli.js.
    $psi.EnvironmentVariables['TOAST_NOTIFY_EVENT']    = $eventName
    $psi.EnvironmentVariables['TOAST_NOTIFY_IS_DEV']   = '0'
    $psi.EnvironmentVariables['TOAST_NOTIFY_LOG_FILE'] = $logFile
    $psi.EnvironmentVariables['TOAST_NOTIFY_HWND']     = $testHwnd
    $psi.EnvironmentVariables['TOAST_NOTIFY_TITLE']    = $title
    $psi.EnvironmentVariables['TOAST_NOTIFY_MESSAGE']  = 'Toast test message'
    $psi.EnvironmentVariables['TOAST_NOTIFY_SOURCE']   = 'Test'

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit(10000) | Out-Null
    Write-Host $stderr.TrimEnd() -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '=== Notification Toast Test ===' -ForegroundColor Cyan
Write-Host '  hook types  : Stop / PermissionRequest / default(info)'
Write-Host '  window cases: no-hwnd / with-hwnd'
Write-Host '  total cases : 6'
Write-Host ''

$cases = @(
    @{ Event = 'Stop';              Hwnd = '';      Label = 'Stop | no hwnd' }
    @{ Event = 'Stop';              Hwnd = "$hwnd"; Label = 'Stop | with hwnd' }
    @{ Event = 'PermissionRequest'; Hwnd = '';      Label = 'PermissionRequest | no hwnd' }
    @{ Event = 'PermissionRequest'; Hwnd = "$hwnd"; Label = 'PermissionRequest | with hwnd' }
    @{ Event = 'Notification';      Hwnd = '';      Label = 'Notification | no hwnd' }
    @{ Event = 'Notification';      Hwnd = "$hwnd"; Label = 'Notification | with hwnd' }
)

$i = 1
foreach ($c in $cases) {
    Write-Host "[$i/6] $($c.Label)" -ForegroundColor Yellow
    Send-Toast $c.Event $c.Hwnd $c.Label
    Write-Host ''
    if ($i -lt $cases.Count) { Start-Sleep -Seconds 2 }
    $i++
}

Write-Host '=== All toasts sent ===' -ForegroundColor Cyan
Write-Host 'Check that:'
Write-Host '  - stop            : green checkmark overlay'
Write-Host '  - permission      : orange permission overlay'
Write-Host '  - default/info    : blue info overlay'
Write-Host '  - with hwnd       : terminal exe icon is composed and taskbar flashes'
Write-Host '  - no hwnd         : static overlay icon only, no flash'
Write-Host '  - title           : [Test] + the case label'
Write-Host '  - message         : fixed "Toast test message"'
Write-Host ''
