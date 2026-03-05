# Claude Code Notification Script (Optimized for speed)
# Send notification FIRST, then do other operations

# 1. Load BurntToast immediately
Import-Module BurntToast -ErrorAction SilentlyContinue

# 2. Read stdin JSON quickly
$hookData = $null
try {
    if ([Console]::In.Peek() -ne -1) {
        $hookData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    }
} catch {}

# 3. Determine title/message
$eventName = if ($hookData.hook_event_name) { $hookData.hook_event_name } else { '' }
switch ($eventName) {
    'Stop'              { $Title = 'Claude Done';             $Message = 'Task finished' }
    'PermissionRequest' { $Title = 'Claude Needs Permission'; $Message = 'Waiting for your approval' }
    default             { $Title = 'Claude Code';             $Message = 'Notification' }
}

# 4. Quick window detection using WMI (faster than Get-CimInstance loop)
$hwnd = $null
$terminalName = 'Terminal'
try {
    # Get parent process chain quickly
    $currentPID = $PID
    for ($i = 0; $i -lt 10; $i++) {
        $proc = Get-Process -Id $currentPID -ErrorAction Stop
        if ($proc.MainWindowHandle -ne 0) {
            $hwnd = $proc.MainWindowHandle
            $terminalName = $proc.ProcessName
            break
        }
        $wmi = Get-WmiObject Win32_Process -Filter "ProcessId = $currentPID" -ErrorAction Stop
        if (-not $wmi -or $wmi.ParentProcessId -eq 0) { break }
        $currentPID = $wmi.ParentProcessId
    }
} catch {}

# 5. Send notification IMMEDIATELY
if (Get-Module -Name BurntToast) {
    $notificationTitle = "$Title ($terminalName)"

    # Build message with project info
    $projectDir = $env:CLAUDE_PROJECT_DIR
    if ($projectDir) {
        $projectName = Split-Path $projectDir -Leaf
        $Message = "$Message`n$projectName"
    }

    if ($hwnd) {
        $activateUrl = "custom.claude-code.activate-window://$hwnd"
        $button = New-BTButton -Content "Open" -Arguments $activateUrl -ActivationType Protocol
        New-BurntToastNotification -Text $notificationTitle, $Message -Button $button
    } else {
        New-BurntToastNotification -Text $notificationTitle, $Message
    }
}

# 6. Flash taskbar (after notification sent)
if ($hwnd) {
    try {
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FlashW { [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO p); [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; } }' -ErrorAction SilentlyContinue
        $flash = New-Object FlashW+FLASHWINFO
        $flash.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($flash)
        $flash.hwnd = $hwnd
        $flash.dwFlags = 15
        $flash.uCount = 0
        $flash.dwTimeout = 0
        [FlashW]::FlashWindowEx([ref]$flash) | Out-Null
    } catch {}
}
