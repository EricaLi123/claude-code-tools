# Notification Script — Native WinRT Toast (zero module dependencies)
# Toast fires FIRST (fast), then window detection + flash (slower)
#
# All hook data (event, session_id, log file path, hwnd) is passed via environment
# variables by cli.js, which reads stdin once before spawning this script.

# log 路径由 cli.js 计算并传入
$LogFile = $env:TOAST_NOTIFY_LOG_FILE
function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff')] [ps1 pid=$PID] $msg"
    [Console]::Error.WriteLine($line)
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

Write-Log "started"

# isDev 由 cli.js 通过环境变量传入
$isDev = $env:TOAST_NOTIFY_IS_DEV -ne "0"
$source = if ($env:TOAST_NOTIFY_SOURCE) { $env:TOAST_NOTIFY_SOURCE } else { '' }

# 1. 从 cli.js 传入的环境变量确定通知标题和内容
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

# 2. 窗口检测
$hwnd            = $null
$terminalName    = 'Terminal'
$terminalExePath = $null

# 3a. 优先使用 cli.js 预先找好的 hwnd（通过 find-hwnd.ps1 在 Node 侧查父链得到）。
# 这样可以绕过 MSYS2 断链问题：git bash 里 PowerShell 自身的父链走不到编辑器窗口，
# 但 Node → cmd → Claude Code Node → Code.exe 这条链在 Node 侧是完整的。
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

# 合成通知图标：底层 exe 图标 + 上层静态符号 PNG
# 缓存到 scripts/icons-cache/{hookName}-{exeSlug}.png，npm install 重建包目录时随之清空
function Get-NotifyIcon($hookName, $exePath) {
    $staticIcon = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, "..", "assets", "icons", "$hookName.png"))
    if (-not ($exePath -and (Test-Path $exePath))) { return $staticIcon }

    $exeSlug  = [System.IO.Path]::GetFileNameWithoutExtension($exePath).ToLower()
    $cacheDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, "..", ".cache"))
    $iconPath = [System.IO.Path]::Combine($cacheDir, "$hookName-$exeSlug.png")
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir | Out-Null }
    if (Test-Path $iconPath) { return $iconPath }

    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $bmp = [System.Drawing.Bitmap]::new(48, 48)
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.Clear([System.Drawing.Color]::Transparent)

        # 底层：exe 图标铺满画布
        $appIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
        if ($appIcon) {
            $appBmp = $appIcon.ToBitmap()
            $appIcon.Dispose()
            $g.DrawImage($appBmp, [System.Drawing.Rectangle]::new(0, 0, 48, 48))
            $appBmp.Dispose()
        }

        # 上层：叠加静态符号 PNG
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

$hookName = switch ($eventName) {
    'Stop'              { 'stop' }
    'PermissionRequest' { 'permission' }
    default             { 'info' }
}
$iconPath = Get-NotifyIcon $hookName $terminalExePath

# 3. 构建 toast 通知内容
# dev 版本在标题前添加 [DEV] 标记
$devMarker = if ($isDev) { "[DEV] " } else { "" }
$notificationTitle = "$devMarker$Title ($terminalName)"
$escapedTitle = [System.Security.SecurityElement]::Escape($notificationTitle)
$escapedMessage = [System.Security.SecurityElement]::Escape($Message)

$actionsXml = ''
if ($hwnd) {
    $activateUrl = "erica-s.claude-code-notify.activate-window://$hwnd"
    $actionsXml = "<actions><action activationType=`"protocol`" arguments=`"$activateUrl`" content=`"Open`"/></actions>"
}

# 图标 XML（路径无效时为空字符串，保证降级安全）
$iconXml = ''
if ($iconPath -and (Test-Path $iconPath)) {
    $uriPath = $iconPath.Replace('\', '/')
    $escapedIconSrc = [System.Security.SecurityElement]::Escape("file:///$uriPath")
    $iconXml = "<image placement=`"appLogoOverride`" src=`"$escapedIconSrc`"/>"
}

# 4. 发送 toast 通知
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

# 5. 任务栏闪烁
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
