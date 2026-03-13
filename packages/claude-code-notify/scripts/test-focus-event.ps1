# 测试：切回 tab 时能否收到 FOCUS_EVENT
# 用法：运行后切走，再切回来，观察是否输出 "FOCUS received"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class ConsoleInput {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadConsoleInput(
        IntPtr hConsoleInput,
        [Out] INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleMode(IntPtr hConsoleInput, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleMode(IntPtr hConsoleInput, uint dwMode);

    public const int STD_INPUT_HANDLE = -10;

    // event types
    public const ushort FOCUS_EVENT = 0x0010;
    public const ushort KEY_EVENT   = 0x0001;
}

[StructLayout(LayoutKind.Explicit)]
public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public FOCUS_EVENT_RECORD FocusEvent;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
}

[StructLayout(LayoutKind.Sequential)]
public struct FOCUS_EVENT_RECORD {
    public uint bSetFocus;  // nonzero = got focus
}

[StructLayout(LayoutKind.Sequential)]
public struct KEY_EVENT_RECORD {
    public uint bKeyDown;
    public ushort wRepeatCount;
    public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode;
    public char UnicodeChar;
    public uint dwControlKeyState;
}
"@

$handle = [ConsoleInput]::GetStdHandle([ConsoleInput]::STD_INPUT_HANDLE)

Write-Host "Waiting for FOCUS_EVENT... Switch away and come back." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to quit." -ForegroundColor Cyan
Write-Host ""

$buf = New-Object INPUT_RECORD[] 1
$read = [uint32]0

while ($true) {
    $ok = [ConsoleInput]::ReadConsoleInput($handle, $buf, 1, [ref]$read)
    if (-not $ok) { continue }

    $evt = $buf[0]
    $ts = Get-Date -Format "HH:mm:ss"

    switch ($evt.EventType) {
        ([ConsoleInput]::FOCUS_EVENT) {
            $focused = $evt.FocusEvent.bSetFocus -ne 0
            $label = if ($focused) { "GOT FOCUS" } else { "LOST FOCUS" }
            $color = if ($focused) { "Green" } else { "DarkGray" }
            Write-Host "[$ts] FOCUS_EVENT: $label" -ForegroundColor $color
        }
        ([ConsoleInput]::KEY_EVENT) {
            # ignore key events
        }
        default {
            Write-Host "[$ts] Event type: $($evt.EventType)" -ForegroundColor DarkGray
        }
    }
}
