param(
    [Parameter(Mandatory)][int]$TargetPid,
    [string]$HookEvent = '',
    [long]$TerminalHwnd = 0,
    [string]$WatcherPidFile = ''
)

$ErrorActionPreference = 'Stop'

function Write-Log($msg) {
    $logFile = $null
    if ($env:TOAST_NOTIFY_LOG_ROOT -and $env:TOAST_NOTIFY_LOG_STEM) {
        $logFile = Join-Path $env:TOAST_NOTIFY_LOG_ROOT "$($env:TOAST_NOTIFY_LOG_STEM)-$(Get-Date -Format 'yyyy-MM-dd').log"
    } else {
        $logFile = $env:TOAST_NOTIFY_LOG_FILE
    }
    $line = "[$((Get-Date).ToString('o'))] [watcher-launcher pid=$PID] $msg"
    try { [System.IO.File]::AppendAllText($logFile, "$line`n") } catch {}
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
