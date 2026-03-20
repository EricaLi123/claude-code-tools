param(
    [Parameter(Mandatory)][int]$TargetPid,
    [string]$HookEvent = '',
    [long]$TerminalHwnd = 0,
    [string]$WatcherPidFile = ''
)

$ErrorActionPreference = 'Stop'

function Write-Log($msg) {
    if (-not $env:TOAST_NOTIFY_LOG_FILE) { return }
    $line = "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')] [watcher-launcher pid=$PID] $msg"
    try { [System.IO.File]::AppendAllText($env:TOAST_NOTIFY_LOG_FILE, "$line`n") } catch {}
}

try {
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $watcherScript = Join-Path $PSScriptRoot 'tab-color-watcher.ps1'
    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $watcherScript,
        '-TargetPid', [string]$TargetPid
    )
    if (-not [string]::IsNullOrEmpty($HookEvent)) {
        $argumentList += @('-HookEvent', $HookEvent)
    }
    if ($TerminalHwnd -gt 0) {
        $argumentList += @('-TerminalHwnd', [string]$TerminalHwnd)
    }

    $proc = Start-Process -FilePath $powershellExe -ArgumentList $argumentList -NoNewWindow -PassThru
    if (-not [string]::IsNullOrEmpty($WatcherPidFile)) {
        [System.IO.File]::WriteAllText($WatcherPidFile, [string]$proc.Id)
    }
    Write-Log "started watcher pid=$($proc.Id) targetPid=$TargetPid hwnd=$TerminalHwnd noNewWindow=true"
}
catch {
    Write-Log "launcher failed: $_"
    throw
}
