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

$notifyScript = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\notify.ps1"
$logFile      = Join-Path $env:TEMP "claude-notify-test.log"
$projectDir   = 'C:\Users\test\my-awesome-project'

# 查找当前桌面上第一个有窗口的进程作为 "有 HWND" 的测试目标
$hwnd = (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
Write-Host "Using HWND: $hwnd" -ForegroundColor DarkGray

function Send-Toast([string]$eventName, [string]$testHwnd = '') {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName             = 'powershell.exe'
    $psi.Arguments            = "-NoProfile -EP Bypass -File `"$notifyScript`""
    $psi.UseShellExecute      = $false
    $psi.RedirectStandardError = $true

    # --- 全量环境变量（与 cli.js 传入保持一致）---
    $psi.EnvironmentVariables['CLAUDE_NOTIFY_EVENT']    = $eventName   # Stop / PermissionRequest / 其他
    $psi.EnvironmentVariables['CLAUDE_NOTIFY_IS_DEV']   = '0'          # 1=显示[DEV]标记, 0=生产
    $psi.EnvironmentVariables['CLAUDE_NOTIFY_LOG_FILE'] = $logFile     # 日志文件路径
    $psi.EnvironmentVariables['CLAUDE_PROJECT_DIR']     = $projectDir  # 项目目录，显示在消息体
    $psi.EnvironmentVariables['CLAUDE_NOTIFY_HWND']     = $testHwnd    # 窗口句柄，空字符串=无窗口

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit(10000) | Out-Null
    Write-Host $stderr.TrimEnd() -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '=== Claude Code Notify - Toast Test ===' -ForegroundColor Cyan
Write-Host '  hook types  : Stop / PermissionRequest / default(info)'
Write-Host '  window cases: no-hwnd / with-hwnd'
Write-Host '  total cases : 6'
Write-Host ''

$cases = @(
    @{ Event = 'Stop';              Hwnd = '';      Label = 'Stop            | no hwnd' }
    @{ Event = 'Stop';              Hwnd = "$hwnd"; Label = 'Stop            | with hwnd' }
    @{ Event = 'PermissionRequest'; Hwnd = '';      Label = 'PermissionRequest | no hwnd' }
    @{ Event = 'PermissionRequest'; Hwnd = "$hwnd"; Label = 'PermissionRequest | with hwnd' }
    @{ Event = 'Notification';      Hwnd = '';      Label = 'default(info)   | no hwnd' }
    @{ Event = 'Notification';      Hwnd = "$hwnd"; Label = 'default(info)   | with hwnd' }
)

$i = 1
foreach ($c in $cases) {
    Write-Host "[$i/6] $($c.Label)" -ForegroundColor Yellow
    Send-Toast $c.Event $c.Hwnd
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
Write-Host '  - 消息体均含项目名: my-awesome-project'
Write-Host ''
