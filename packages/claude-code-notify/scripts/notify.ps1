# Claude Code Notification Script — Native WinRT Toast (zero module dependencies)
# Toast fires FIRST (fast), then window detection + flash (slower)

function Write-Log($msg) { [Console]::Error.WriteLine("claude-code-notify: $msg") }

# 1. Read stdin JSON
$hookData = $null
try {
    if ([Console]::In.Peek() -ne -1) {
        $hookData = [Console]::In.ReadToEnd() | ConvertFrom-Json
        Write-Log "stdin received"
    } else {
        Write-Log "stdin empty"
    }
} catch { Write-Log "stdin parse failed: $_" }

# 2. Determine title/message
$eventName = if ($hookData.hook_event_name) { $hookData.hook_event_name } else { '' }
switch ($eventName) {
    'Stop'              { $Title = 'Claude Done';             $Message = 'Task finished' }
    'PermissionRequest' { $Title = 'Claude Needs Permission'; $Message = 'Waiting for your approval' }
    default             { $Title = 'Claude';             $Message = 'Notification' }
}
$projectDir = $env:CLAUDE_PROJECT_DIR
if ($projectDir) {
    $projectName = Split-Path $projectDir -Leaf
    $Message = "$Message`n$projectName"
}
Write-Log "event=$eventName title=$Title"

# 3. Window detection
$hwnd = $null
$terminalName = 'Terminal'

# 3a. Walk process tree (covers Windows Terminal, VS Code, Cursor)
try {
    $procMap = @{}
    Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { $procMap[[int]$_.ProcessId] = [int]$_.ParentProcessId }
    $currentPID = $PID
    for ($i = 0; $i -lt 50; $i++) {
        try {
            $proc = Get-Process -Id $currentPID -ErrorAction Stop
            if ($proc.MainWindowHandle -ne 0) {
                $hwnd = $proc.MainWindowHandle
                $terminalName = $proc.ProcessName
                Write-Log "found window at depth=$i pid=$currentPID name=$terminalName"
                break
            }
        } catch {}
        if (-not $procMap.ContainsKey($currentPID) -or $procMap[$currentPID] -eq 0) { break }
        $currentPID = $procMap[$currentPID]
    }
} catch { Write-Log "tree walk failed: $_" }

# 3b. Fallback: conhost whose parent is our ancestor (standalone cmd/powershell)
if (-not $hwnd) {
    try {
        $ancestors = @{}
        $ap = $PID
        for ($j = 0; $j -lt 50; $j++) {
            $ancestors[$ap] = $true
            if (-not $procMap.ContainsKey($ap) -or $procMap[$ap] -eq 0) { break }
            $ap = $procMap[$ap]
        }
        $conhost = Get-Process -Name conhost -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowHandle -ne 0 -and $procMap.ContainsKey($_.Id) -and $ancestors.ContainsKey($procMap[$_.Id])
        } | Select-Object -First 1
        if ($conhost) {
            $hwnd = $conhost.MainWindowHandle
            $terminalName = 'Console'
            Write-Log "fallback conhost: pid=$($conhost.Id)"
        }
    } catch { Write-Log "conhost fallback failed: $_" }
}

Write-Log "hwnd=$hwnd terminal=$terminalName"

# 4. Build notification
$friendlyNames = @{
    'WindowsTerminal' = 'Windows Terminal'
    'Code' = 'VS Code'
    'Cursor' = 'Cursor'
    'Console' = 'Console'
}
$displayName = if ($friendlyNames[$terminalName]) { $friendlyNames[$terminalName] } else { $terminalName }
$notificationTitle = "$Title ($displayName)"
$escapedTitle = [System.Security.SecurityElement]::Escape($notificationTitle)
$escapedMessage = [System.Security.SecurityElement]::Escape($Message)

$actionsXml = ''
if ($hwnd) {
    $activateUrl = "erica-s.claude-code-notify.activate-window://$hwnd"
    $actionsXml = "<actions><action activationType=`"protocol`" arguments=`"$activateUrl`" content=`"Open`"/></actions>"
}

# 5. Send toast
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

    $toastXml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>$escapedTitle</text>
      <text>$escapedMessage</text>
    </binding>
  </visual>
  $actionsXml
</toast>
"@

    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $xml.LoadXml($toastXml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Write-Log "toast sent: $notificationTitle"
} catch { Write-Log "toast failed: $_" }

# 6. Flash taskbar
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
        Write-Log "flash sent"
    } catch { Write-Log "flash failed: $_" }
}
