# Native WinRT toast sender with no extra PowerShell modules.
# The toast is sent first, then any window/taskbar hinting happens afterwards.
# cli.js resolves the payload once and passes notify inputs through env vars.

function Resolve-LogFile {
    if ($env:TOAST_NOTIFY_LOG_ROOT -and $env:TOAST_NOTIFY_LOG_STEM) {
        return Join-Path $env:TOAST_NOTIFY_LOG_ROOT "$($env:TOAST_NOTIFY_LOG_STEM)-$(Get-Date -Format 'yyyy-MM-dd').log"
    }
    return $env:TOAST_NOTIFY_LOG_FILE
}

function Write-Log($msg) {
    $LogFile = Resolve-LogFile
    $line = "[$((Get-Date).ToString('o'))] [ps1 pid=$PID] $msg"
    [Console]::Error.WriteLine($line)
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

Write-Log "started"

# cli.js passes the dev/prod marker through the environment.
$isDev = $env:TOAST_NOTIFY_IS_DEV -ne "0"
$source = if ($env:TOAST_NOTIFY_SOURCE) { $env:TOAST_NOTIFY_SOURCE } else { '' }
$entryPointId = if ($env:TOAST_NOTIFY_ENTRY_POINT) { $env:TOAST_NOTIFY_ENTRY_POINT } else { '' }

# 1. Resolve title/message from the env vars prepared by cli.js.
$eventName = if ($env:TOAST_NOTIFY_EVENT) { $env:TOAST_NOTIFY_EVENT } else { '' }
$baseTitle = if ($env:TOAST_NOTIFY_TITLE) { $env:TOAST_NOTIFY_TITLE } else { '' }
$message = if ($env:TOAST_NOTIFY_MESSAGE) { $env:TOAST_NOTIFY_MESSAGE } else { '' }

if (-not $baseTitle) {
    switch ($eventName) {
        'Stop' {
            $baseTitle = 'Done'
        }
        'PermissionRequest' {
            $baseTitle = 'Needs Approval'
        }
        'InputRequest' {
            $baseTitle = 'Input Needed'
        }
        default {
            $baseTitle = 'Notification'
        }
    }
}

if (-not $message) {
    switch ($eventName) {
        'Stop' {
            $message = 'Task finished'
        }
        'PermissionRequest' {
            $message = 'Waiting for your approval'
        }
        'InputRequest' {
            $message = 'Waiting for your input'
        }
        default {
            $message = 'Notification'
        }
    }
}

if ($source) {
    $Title = "[$source] $baseTitle"
} else {
    $Title = $baseTitle
}
$Message = $message
Write-Log "source=$source event=$eventName title=$Title message=$Message"

# 2. Capture window metadata when available.
$hwnd            = $null
$terminalName    = 'Terminal'
$terminalExePath = $null

# Prefer the HWND already resolved by cli.js. Node-side parent-chain lookup is
# more reliable than rediscovering the terminal from PowerShell in Git Bash /
# MSYS2-flavored launch chains.
if ($env:TOAST_NOTIFY_HWND) {
    $hwnd = [IntPtr][long]$env:TOAST_NOTIFY_HWND
    try {
        $proc = Get-Process -Id (Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd } | Select-Object -First 1 -ExpandProperty Id) -ErrorAction Stop
        $terminalName    = if ($proc.Product) { $proc.Product } elseif ($proc.Description) { $proc.Description } else { $proc.ProcessName }
        $terminalExePath = $proc.Path
    } catch {}
    Write-Log "hwnd from cli.js: $hwnd terminal=$terminalName exe=$terminalExePath"
}

Write-Log "hwnd=$hwnd terminal=$terminalName"

# Compose the final toast icon as:
#   terminal exe icon + static overlay icon
# Cache output under .cache/{iconKey}-{exeSlug}.png so reinstalling the package
# naturally clears stale generated icons.
function Get-NotifyIcon($iconKey, $exePath) {
    $staticIcon = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, "..", "assets", "icons", "$iconKey.png"))
    if (-not ($exePath -and (Test-Path $exePath))) { return $staticIcon }

    $exeSlug  = [System.IO.Path]::GetFileNameWithoutExtension($exePath).ToLower()
    $cacheDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, "..", ".cache"))
    $iconPath = [System.IO.Path]::Combine($cacheDir, "$iconKey-$exeSlug.png")
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir | Out-Null }
    if (Test-Path $iconPath) { return $iconPath }

    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $bmp = [System.Drawing.Bitmap]::new(48, 48)
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.Clear([System.Drawing.Color]::Transparent)

        # Draw the terminal/app icon first.
        $appIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
        if ($appIcon) {
            $appBmp = $appIcon.ToBitmap()
            $appIcon.Dispose()
            $g.DrawImage($appBmp, [System.Drawing.Rectangle]::new(0, 0, 48, 48))
            $appBmp.Dispose()
        }

        # Then overlay the static notify glyph.
        $overlay = [System.Drawing.Bitmap]::new($staticIcon)
        $g.DrawImage($overlay, [System.Drawing.Rectangle]::new(0, 0, 48, 48))
        $overlay.Dispose()
        $g.Dispose()

        $bmp.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Log "icon cached: $iconPath"
        return $iconPath
    } catch {
        Write-Log "icon generation failed: $_"
        return $staticIcon
    }
}

$iconKey = switch ($eventName) {
    'Stop'              { 'stop' }
    'PermissionRequest' { 'permission' }
    'InputRequest'      { 'permission' }
    default             { 'info' }
}
$iconPath = Get-NotifyIcon $iconKey $terminalExePath

# 3. Build the toast payload.
# Dev builds prepend [DEV] to the toast title.
$devMarker = if ($isDev) { "[DEV] " } else { "" }
$entryPointMarker = if ($entryPointId) { "[$entryPointId] " } else { "" }
$notificationTitle = "$devMarker$entryPointMarker$Title ($terminalName)"
$escapedTitle = [System.Security.SecurityElement]::Escape($notificationTitle)
$escapedMessage = [System.Security.SecurityElement]::Escape($Message)

# Keep the icon optional so the toast still degrades safely if the path fails.
$iconXml = ''
if ($iconPath -and (Test-Path $iconPath)) {
    $uriPath = $iconPath.Replace('\', '/')
    $escapedIconSrc = [System.Security.SecurityElement]::Escape("file:///$uriPath")
    $iconXml = "<image placement=`"appLogoOverride`" src=`"$escapedIconSrc`"/>"
}

# 4. Send the toast.
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

    $toastXml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      $iconXml
      <text>$escapedTitle</text>
      <text>$escapedMessage</text>
    </binding>
  </visual>
</toast>
"@

    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $xml.LoadXml($toastXml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Write-Log "toast sent: $notificationTitle"
} catch { Write-Log "toast failed: $_" }

# 5. Flash the taskbar button when we know the source HWND.
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
