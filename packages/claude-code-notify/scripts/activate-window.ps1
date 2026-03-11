# 激活窗口脚本 - 由 claude-code-notify 协议处理器调用
# 参数: 协议 URL，格式为 erica-s.claude-code-notify.activate-window://<窗口句柄>

$url = $args[0]
$handleString = $url -replace '^[^:]+://', '' -replace '[/\\"]', ''
$handleString = $handleString.Trim()
if (-not $handleString) { exit 1 }
try {
    $handleInt = [long]$handleString
    $hwnd = [IntPtr]$handleInt
} catch { exit 1 }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@ -ErrorAction SilentlyContinue

if (-not [WinAPI]::IsWindow($hwnd)) { exit 1 }
if ([WinAPI]::IsIconic($hwnd)) { [WinAPI]::ShowWindow($hwnd, 9) | Out-Null }
[WinAPI]::SetForegroundWindow($hwnd) | Out-Null
