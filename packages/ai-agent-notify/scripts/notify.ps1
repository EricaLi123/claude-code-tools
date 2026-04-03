# Notification Script 鈥?Native WinRT Toast (zero module dependencies)
# Toast fires FIRST (fast), then window detection + flash (slower)
#
# All hook data (event, session_id, log file path, hwnd) is passed via environment
# variables by cli.js, which reads stdin once before spawning this script.

# log 璺緞鐢?cli.js 璁＄畻骞朵紶鍏?
$LogFile = $env:TOAST_NOTIFY_LOG_FILE
function Write-Log($msg) {
    $line = "[$((Get-Date).ToString('o'))] [ps1 pid=$PID] $msg"
    [Console]::Error.WriteLine($line)
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

Write-Log "started"

# isDev 鐢?cli.js 閫氳繃鐜鍙橀噺浼犲叆
$isDev = $env:TOAST_NOTIFY_IS_DEV -ne "0"
$source = if ($env:TOAST_NOTIFY_SOURCE) { $env:TOAST_NOTIFY_SOURCE } else { '' }

# 1. 浠?cli.js 浼犲叆鐨勭幆澧冨彉閲忕‘瀹氶€氱煡鏍囬鍜屽唴瀹?
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

# 2. 绐楀彛妫€娴?
$hwnd            = $null
$terminalName    = 'Terminal'
$terminalExePath = $null

# 3a. 浼樺厛浣跨敤 cli.js 棰勫厛鎵惧ソ鐨?hwnd锛堥€氳繃 find-hwnd.ps1 鍦?Node 渚ф煡鐖堕摼寰楀埌锛夈€?
# 杩欐牱鍙互缁曡繃 MSYS2 鏂摼闂锛歡it bash 閲?PowerShell 鑷韩鐨勭埗閾捐蛋涓嶅埌缂栬緫鍣ㄧ獥鍙ｏ紝
# 浣?Node 渚х湅鍒扮殑鐖惰繘绋嬮摼浠嶇劧鏇村畬鏁达紝鑳芥洿绋冲畾鍛戒腑鐪熷疄缁堢绐楀彛銆?
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

# 鍚堟垚閫氱煡鍥炬爣锛氬簳灞?exe 鍥炬爣 + 涓婂眰闈欐€佺鍙?PNG
# 缂撳瓨鍒?scripts/icons-cache/{iconKey}-{exeSlug}.png锛宯pm install 閲嶅缓鍖呯洰褰曟椂闅忎箣娓呯┖
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

        # 搴曞眰锛歟xe 鍥炬爣閾烘弧鐢诲竷
        $appIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
        if ($appIcon) {
            $appBmp = $appIcon.ToBitmap()
            $appIcon.Dispose()
            $g.DrawImage($appBmp, [System.Drawing.Rectangle]::new(0, 0, 48, 48))
            $appBmp.Dispose()
        }

        # 涓婂眰锛氬彔鍔犻潤鎬佺鍙?PNG
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

# 3. 鏋勫缓 toast 閫氱煡鍐呭
# dev 鐗堟湰鍦ㄦ爣棰樺墠娣诲姞 [DEV] 鏍囪
$devMarker = if ($isDev) { "[DEV] " } else { "" }
$notificationTitle = "$devMarker$Title ($terminalName)"
$escapedTitle = [System.Security.SecurityElement]::Escape($notificationTitle)
$escapedMessage = [System.Security.SecurityElement]::Escape($Message)

$actionsXml = ''
if ($hwnd) {
    $activateUrl = "erica-s.ai-agent-notify.activate-window://$hwnd"
    $actionsXml = "<actions><action activationType=`"protocol`" arguments=`"$activateUrl`" content=`"Open`"/></actions>"
}

# 鍥炬爣 XML锛堣矾寰勬棤鏁堟椂涓虹┖瀛楃涓诧紝淇濊瘉闄嶇骇瀹夊叏锛?
$iconXml = ''
if ($iconPath -and (Test-Path $iconPath)) {
    $uriPath = $iconPath.Replace('\', '/')
    $escapedIconSrc = [System.Security.SecurityElement]::Escape("file:///$uriPath")
    $iconXml = "<image placement=`"appLogoOverride`" src=`"$escapedIconSrc`"/>"
}

# 4. 鍙戦€?toast 閫氱煡
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

# 5. 浠诲姟鏍忛棯鐑?
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
