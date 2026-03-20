# Toast 测试脚本
# Run: powershell -EP Bypass -File test/test-toast.ps1
#
# 测试要求：
#   1. 完全仿真 cli.js → notify.ps1 的调用方式，所有环境变量均显式传入
#   2. 测试矩阵 = hook 类型 × 窗口定位能力 的全量叉乘：
#        hook 类型        : Stop / PermissionRequest / (default/info)
#        窗口定位          : 无 HWND（纯通知）/ 有 HWND（含窗口闪烁）
#      共 6 个 case
#   3. 每个 case 间隔 2 秒，方便肉眼逐条核对

$scriptRoot    = Split-Path -Parent $PSScriptRoot
$notifyScript  = Join-Path $scriptRoot "scripts\notify.ps1"
$findHwndScript = Join-Path $scriptRoot "scripts\find-hwnd.ps1"
$logFile       = Join-Path $env:TEMP "claude-notify-test.log"

# 使用当前终端窗口（从当前 PID 向上找父链中第一个有窗口的进程）
$findResult = & powershell.exe -NoProfile -EP Bypass -File $findHwndScript -StartPid $PID 2>$null
$hwnd = [int]($findResult | Select-Object -Last 1)
if ($hwnd -eq 0) {
    Write-Host "Warning: current window HWND not found, with-hwnd cases will behave like no-hwnd" -ForegroundColor Yellow
}
Write-Host "Using HWND: $hwnd (current window)" -ForegroundColor DarkGray

function Send-Toast([string]$eventName, [string]$testHwnd = '', [string]$title = '') {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName             = 'powershell.exe'
    $psi.Arguments            = "-NoProfile -EP Bypass -File `"$notifyScript`""
    $psi.UseShellExecute      = $false
    $psi.RedirectStandardError = $true

    # --- 全量环境变量（与 cli.js 传入保持一致）---
    $psi.EnvironmentVariables['TOAST_NOTIFY_EVENT']      = $eventName   # Stop / PermissionRequest / 其他
    $psi.EnvironmentVariables['TOAST_NOTIFY_IS_DEV']     = '0'          # 1=显示[DEV]标记, 0=生产
    $psi.EnvironmentVariables['TOAST_NOTIFY_LOG_FILE']   = $logFile     # 日志文件路径
    $psi.EnvironmentVariables['TOAST_NOTIFY_HWND']       = $testHwnd    # 窗口句柄，空字符串=无窗口
    $psi.EnvironmentVariables['TOAST_NOTIFY_TITLE']      = $title       # 测试 case 名称作为标题
    $psi.EnvironmentVariables['TOAST_NOTIFY_MESSAGE']    = 'Toast test message'
    $psi.EnvironmentVariables['TOAST_NOTIFY_SOURCE']     = 'Test'

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
    @{ Event = 'Stop';              Hwnd = '';        Label = 'Stop | no hwnd' }
    @{ Event = 'Stop';              Hwnd = "$hwnd";   Label = 'Stop | with hwnd' }
    @{ Event = 'PermissionRequest'; Hwnd = '';        Label = 'PermissionRequest | no hwnd' }
    @{ Event = 'PermissionRequest'; Hwnd = "$hwnd";   Label = 'PermissionRequest | with hwnd' }
    @{ Event = 'Notification';      Hwnd = '';        Label = 'Notification | no hwnd' }
    @{ Event = 'Notification';      Hwnd = "$hwnd";   Label = 'Notification | with hwnd' }
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
Write-Host '  - stop           : 绿色 checkmark 图标'
Write-Host '  - permissionRequest: 橙色 Q 图标'
Write-Host '  - default/info   : 蓝色 i 图标'
Write-Host '  - with hwnd      : 图标叠加终端 exe 图标，任务栏闪烁'
Write-Host '  - no hwnd        : 纯静态符号图标，无闪烁'
Write-Host '  - title          : 每条通知标题 = [Test] + 测试 case 名称'
Write-Host '  - message        : 固定为 Toast test message'
Write-Host ''
