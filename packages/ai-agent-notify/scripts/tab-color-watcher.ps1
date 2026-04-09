# Tab 颜色 watcher：先附着到目标 shell 的 console，保证 hook 场景也能命中目标 tab；
# 用户回到目标窗口后，再通过标准流和附着 console 双通道写 reset OSC 恢复默认颜色。
# 作为独立进程运行。
param(
    [Parameter(Mandatory)][int]$TargetPid,
    [string]$HookEvent = '',
    [long]$TerminalHwnd = 0
)

$ErrorActionPreference = 'Stop'

# --- 日志 ---
function Resolve-LogFile {
    if ($env:TOAST_NOTIFY_LOG_ROOT -and $env:TOAST_NOTIFY_LOG_STEM) {
        return Join-Path $env:TOAST_NOTIFY_LOG_ROOT "$($env:TOAST_NOTIFY_LOG_STEM)-$(Get-Date -Format 'yyyy-MM-dd').log"
    }
    return $env:TOAST_NOTIFY_LOG_FILE
}

function Write-Log($msg) {
    $line = "[$((Get-Date).ToString('o'))] [watcher pid=$PID] $msg"
    $logFile = Resolve-LogFile
    try { [System.IO.File]::AppendAllText($logFile, "$line`n") } catch {}
}

Write-Log "started TargetPid=$TargetPid HookEvent=$HookEvent TerminalHwnd=$TerminalHwnd"

# --- 颜色映射 ---
$colorMap = @{
    'Stop'              = 'rgb:33/cc/33'
    'PermissionRequest' = 'rgb:ff/99/00'
    'InputRequest'      = 'rgb:ff/99/00'
}
$color = if ($colorMap.ContainsKey($HookEvent)) { $colorMap[$HookEvent] } else { 'rgb:33/99/ff' }

$ESC = [char]0x1B
$ST  = "$ESC\"

# --- P/Invoke 定义 ---
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

[StructLayout(LayoutKind.Sequential)]
public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
}

public class TabWatcher {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool WriteFile(
        IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool WriteConsoleW(
        IntPtr hConsoleOutput, string lpBuffer, uint nNumberOfCharsToWrite,
        out uint lpNumberOfCharsWritten, IntPtr lpReserved);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint WaitForMultipleObjects(uint nCount, IntPtr[] lpHandles, bool bWaitAll, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateMutexW(IntPtr lpMutexAttributes, bool bInitialOwner, string lpName);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool ReleaseMutex(IntPtr hMutex);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNumberOfConsoleInputEvents(IntPtr hConsoleInput, out uint lpcNumberOfEvents);

    public const uint SYNCHRONIZE = 0x00100000;
    public const uint GENERIC_READ  = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint OPEN_EXISTING = 3;
    public const uint WAIT_OBJECT_0 = 0;
    public const uint WAIT_ABANDONED_0 = 0x00000080;
    public const uint WAIT_TIMEOUT = 0x00000102;
    public const uint WAIT_FAILED = 0xFFFFFFFF;
    public const int ERROR_ALREADY_EXISTS = 183;
    public static void SleepMs(int milliseconds) {
        Thread.Sleep(milliseconds);
    }

    public static uint GetLastInputTick() {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) {
            return 0;
        }
        return info.dwTime;
    }
}
'@

function Write-OscToInheritedStreams([string]$seq, [string]$label) {
    $data = [System.Text.Encoding]::ASCII.GetBytes($seq)
    $stdoutOk = $false
    $stderrOk = $false

    try {
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($data, 0, $data.Length)
        $stdout.Flush()
        $stdoutOk = $true
    } catch {
        Write-Log "$label via inherited stdout failed: $_"
    }

    try {
        $stderr = [Console]::OpenStandardError()
        $stderr.Write($data, 0, $data.Length)
        $stderr.Flush()
        $stderrOk = $true
    } catch {
        Write-Log "$label via inherited stderr failed: $_"
    }

    if ($stdoutOk -or $stderrOk) {
        Write-Log "$label via inherited streams stdout=$stdoutOk stderr=$stderrOk"
        return $true
    }

    Write-Log "$label failed on both inherited streams"
    return $false
}

function Attach-TargetConsole {
    [TabWatcher]::FreeConsole() | Out-Null
    $attached = [TabWatcher]::AttachConsole([uint32]$TargetPid)
    if (-not $attached) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Log "AttachConsole failed err=$err"
        return [IntPtr]::Zero
    }

    Write-Log "attached to console of pid=$TargetPid"
    $hIn = [TabWatcher]::CreateFileW(
        "CONIN$",
        [TabWatcher]::GENERIC_READ -bor [TabWatcher]::GENERIC_WRITE,
        [TabWatcher]::FILE_SHARE_READ -bor [TabWatcher]::FILE_SHARE_WRITE,
        [IntPtr]::Zero,
        [TabWatcher]::OPEN_EXISTING,
        0,
        [IntPtr]::Zero
    )
    $invalidHandle = [IntPtr](-1)
    if ($hIn -eq $invalidHandle) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Log "CreateFileW CONIN$ failed err=$err"
        $hIn = [IntPtr]::Zero
    } else {
        Write-Log "opened CONIN$ handle=$hIn"
    }

    $hOut = [TabWatcher]::CreateFileW(
        "CONOUT$",
        [TabWatcher]::GENERIC_READ -bor [TabWatcher]::GENERIC_WRITE,
        [TabWatcher]::FILE_SHARE_READ -bor [TabWatcher]::FILE_SHARE_WRITE,
        [IntPtr]::Zero,
        [TabWatcher]::OPEN_EXISTING,
        0,
        [IntPtr]::Zero
    )
    if ($hOut -eq $invalidHandle) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Log "CreateFileW CONOUT$ failed err=$err"
        $hOut = [IntPtr]::Zero
    } else {
        Write-Log "opened CONOUT$ handle=$hOut"
    }

    return @{
        InputHandle = $hIn
        OutputHandle = $hOut
    }
}

function Write-OscToAttachedConsole([IntPtr]$hOut, [string]$seq, [string]$label) {
    if ($hOut -eq [IntPtr]::Zero) {
        Write-Log "$label via attached console skipped: no handle"
        return $false
    }

    $consoleOk = $false
    try {
        $charsWritten = 0
        $consoleOk = [TabWatcher]::WriteConsoleW($hOut, $seq, [uint32]$seq.Length, [ref]$charsWritten, [IntPtr]::Zero)
        if ($consoleOk -and $charsWritten -eq $seq.Length) {
            Write-Log "$label via attached console WriteConsoleW chars=$charsWritten"
            return $true
        }
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Log "$label via attached console WriteConsoleW failed err=$err chars=$charsWritten"
    } catch {
        Write-Log "$label via attached console WriteConsoleW exception: $_"
    }

    try {
        $data = [System.Text.Encoding]::ASCII.GetBytes($seq)
        $bytesWritten = 0
        $fileOk = [TabWatcher]::WriteFile($hOut, $data, [uint32]$data.Length, [ref]$bytesWritten, [IntPtr]::Zero)
        if ($fileOk -and $bytesWritten -eq $data.Length) {
            Write-Log "$label via attached console WriteFile bytes=$bytesWritten"
            return $true
        }
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Log "$label via attached console WriteFile failed err=$err bytes=$bytesWritten"
    } catch {
        Write-Log "$label via attached console WriteFile exception: $_"
    }

    return $false
}

function Get-ConsoleInputEventCount([IntPtr]$hIn) {
    if ($hIn -eq [IntPtr]::Zero) {
        return $null
    }

    $count = 0
    $ok = [TabWatcher]::GetNumberOfConsoleInputEvents($hIn, [ref]$count)
    if (-not $ok) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Log "GetNumberOfConsoleInputEvents failed err=$err"
        return $null
    }
    return [uint32]$count
}

# --- Named Mutex 防重复 ---
$mutexName = "Global\ai-agent-notify-tab-$TargetPid"
$hMutex = [TabWatcher]::CreateMutexW([IntPtr]::Zero, $true, $mutexName)
if ($hMutex -eq [IntPtr]::Zero) {
    Write-Log "CreateMutex failed, exiting"
    exit 1
}
$lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($lastErr -eq [TabWatcher]::ERROR_ALREADY_EXISTS) {
    Write-Log "mutex already exists, waiting for old watcher to release"
    $waitResult = [TabWatcher]::WaitForSingleObject($hMutex, 5000)
    if ($waitResult -eq [TabWatcher]::WAIT_FAILED) {
        Write-Log "failed to acquire mutex, exiting"
        [TabWatcher]::CloseHandle($hMutex)
        exit 1
    }
    Write-Log "acquired mutex from old watcher"
}

$exitCode = 0
$hIn = [IntPtr]::Zero
$hOut = [IntPtr]::Zero
$hProcess = [IntPtr]::Zero
try {
    $consoleHandles = Attach-TargetConsole
    if ($consoleHandles) {
        $hIn = $consoleHandles.InputHandle
        $hOut = $consoleHandles.OutputHandle
    }
    $setColor = "$ESC]4;264;$color$ST"
    $setViaAttached = Write-OscToAttachedConsole $hOut $setColor "set tab color=$color"
    $setViaStreams = Write-OscToInheritedStreams $setColor "set tab color=$color"
    Write-Log "set color summary attached=$setViaAttached streams=$setViaStreams"

    $hProcess = [TabWatcher]::OpenProcess([TabWatcher]::SYNCHRONIZE, $false, [uint32]$TargetPid)
    if ($hProcess -eq [IntPtr]::Zero) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "OpenProcess failed err=$err"
    }

    $baselineForeground = [TabWatcher]::GetForegroundWindow()
    $baselineInputTick = [TabWatcher]::GetLastInputTick()
    $baselineConsoleInputCount = Get-ConsoleInputEventCount $hIn
    $consoleInputArmed = ($null -eq $baselineConsoleInputCount) -or ($baselineConsoleInputCount -eq 0)
    $sawTargetConsoleInput = $false
    $lastDrainCount = $baselineConsoleInputCount
    Write-Log "waiting for target console input + foreground return baselineForeground=$baselineForeground baselineInputTick=$baselineInputTick baselineConsoleInputCount=$baselineConsoleInputCount armed=$consoleInputArmed"
    if ($TerminalHwnd -le 0) {
        Write-Log "no terminal hwnd provided; reset will only stop when target process exits"
    }

    $waitHandles = if ($hIn -ne [IntPtr]::Zero) { @($hProcess, $hIn) } else { @($hProcess) }

    while ($true) {
        $result = if ($waitHandles.Count -gt 1) {
            [TabWatcher]::WaitForMultipleObjects([uint32]$waitHandles.Count, $waitHandles, $false, 150)
        } else {
            [TabWatcher]::WaitForSingleObject($hProcess, 150)
        }

        if ($result -eq [TabWatcher]::WAIT_OBJECT_0) {
            Write-Log "target process exited"
            break
        }

        if ($waitHandles.Count -gt 1 -and $result -eq ([TabWatcher]::WAIT_OBJECT_0 + 1)) {
            if (-not $consoleInputArmed) {
                $currentConsoleInputCount = Get-ConsoleInputEventCount $hIn
                if ($currentConsoleInputCount -eq 0) {
                    $consoleInputArmed = $true
                    Write-Log "target console input armed after drain"
                } else {
                    if ($currentConsoleInputCount -ne $lastDrainCount) {
                        Write-Log "target console still draining baselineInputCount=$baselineConsoleInputCount currentInputCount=$currentConsoleInputCount"
                        $lastDrainCount = $currentConsoleInputCount
                    }
                }
            } else {
                $sawTargetConsoleInput = $true
                Write-Log "target console input signaled"
            }
        }

        $isExpectedWaitResult =
            ($result -eq [TabWatcher]::WAIT_TIMEOUT) -or
            ($waitHandles.Count -gt 1 -and $result -eq ([TabWatcher]::WAIT_OBJECT_0 + 1))
        if (-not $isExpectedWaitResult) {
            $wmErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Write-Log "wait returned unexpected result=$result err=$wmErr"
            break
        }

        if (-not $consoleInputArmed -and $hIn -ne [IntPtr]::Zero) {
            $currentConsoleInputCount = Get-ConsoleInputEventCount $hIn
            if ($currentConsoleInputCount -eq 0) {
                $consoleInputArmed = $true
                Write-Log "target console input armed after timeout drain"
            } elseif ($currentConsoleInputCount -ne $lastDrainCount) {
                Write-Log "target console still draining baselineInputCount=$baselineConsoleInputCount currentInputCount=$currentConsoleInputCount"
                $lastDrainCount = $currentConsoleInputCount
            }
        }

        $currentForeground = [TabWatcher]::GetForegroundWindow()
        $currentInputTick = [TabWatcher]::GetLastInputTick()
        if ($TerminalHwnd -gt 0 -and $currentForeground -eq [IntPtr]$TerminalHwnd -and $currentInputTick -ne 0 -and $currentInputTick -ne $baselineInputTick -and $sawTargetConsoleInput) {
            Write-Log "foreground returned with target console input foreground=$currentForeground inputTick=$currentInputTick"
            [TabWatcher]::SleepMs(100)
            $resetColor = "$ESC]104;264$ST"
            $resetViaStreams = Write-OscToInheritedStreams $resetColor "reset tab color"
            $resetViaAttached = Write-OscToAttachedConsole $hOut $resetColor "reset tab color"
            Write-Log "reset color summary attached=$resetViaAttached streams=$resetViaStreams"
            break
        }
    }

}
catch {
    Write-Log "error: $_"
    $exitCode = 1
}
finally {
    if ($hProcess -ne [IntPtr]::Zero) {
        [TabWatcher]::CloseHandle($hProcess) | Out-Null
    }
    if ($hOut -ne [IntPtr]::Zero) {
        [TabWatcher]::CloseHandle($hOut) | Out-Null
    }
    if ($hIn -ne [IntPtr]::Zero) {
        [TabWatcher]::CloseHandle($hIn) | Out-Null
    }
    [TabWatcher]::ReleaseMutex($hMutex) | Out-Null
    [TabWatcher]::CloseHandle($hMutex) | Out-Null
    Write-Log "exiting code=$exitCode"
}

exit $exitCode
