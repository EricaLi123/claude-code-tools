# 从指定 PID 向上遍历父进程链，输出第一个有窗口 handle 的进程的 hwnd。
# 由 cli.js 在 spawn notify.ps1 之前调用，结果通过 TOAST_NOTIFY_HWND 环境变量传入。
# -IncludeShellPid 启用时，输出格式为 hwnd|shellPid|isWindowsTerminal(1/0)
param([int]$StartPid, [switch]$IncludeShellPid)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class PH {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
    [DllImport("kernel32.dll")]
    static extern bool Process32First(IntPtr h, ref PE e);
    [DllImport("kernel32.dll")]
    static extern bool Process32Next(IntPtr h, ref PE e);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
    public struct PE {
        public uint sz, u, pid; public IntPtr heap;
        public uint mod, thr, ppid; public int pri; public uint fl;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
    }
    public static Dictionary<int,int> Map() {
        var m = new Dictionary<int,int>();
        IntPtr s = CreateToolhelp32Snapshot(2, 0);
        PE e = new PE(); e.sz = (uint)System.Runtime.InteropServices.Marshal.SizeOf(e);
        if (Process32First(s, ref e)) do { m[(int)e.pid] = (int)e.ppid; } while (Process32Next(s, ref e));
        CloseHandle(s);
        return m;
    }
}
'@ 2>$null

$map = [PH]::Map()
$cur = $StartPid
$shellPid = 0
$isWindowsTerminal = $false
$shellNames = @('bash','powershell','pwsh','cmd','zsh','fish')
$wtNames = @('WindowsTerminal','OpenConsole')

[Console]::Error.WriteLine("find-hwnd: StartPid=$StartPid IncludeShellPid=$IncludeShellPid")
for ($i = 0; $i -lt 50; $i++) {
    try {
        $p = Get-Process -Id $cur -ErrorAction Stop
        $pName = $p.ProcessName
        [Console]::Error.WriteLine("find-hwnd: depth=$i pid=$cur name=$pName hwnd=$($p.MainWindowHandle)")
        # 记录最近的 shell 进程 PID。
        # 不取“第一个 shell”，因为全局命令经常会经过短命的 cmd/volta 包装层；
        # watcher 需要附着到离终端最近、仍然存活的交互 shell。
        if ($IncludeShellPid -and $shellNames -contains $pName) {
            $shellPid = $cur
            [Console]::Error.WriteLine("find-hwnd: shellPid=$shellPid")
        }
        # 检测 Windows Terminal
        if ($IncludeShellPid -and -not $isWindowsTerminal -and $wtNames -contains $pName) {
            $isWindowsTerminal = $true
            [Console]::Error.WriteLine("find-hwnd: isWindowsTerminal=true (detected $pName)")
        }
        if ($p.MainWindowHandle -ne 0) {
            [Console]::Error.WriteLine("find-hwnd: found hwnd=$($p.MainWindowHandle)")
            if ($IncludeShellPid) {
                $wtFlag = if ($isWindowsTerminal) { '1' } else { '0' }
                Write-Output "$($p.MainWindowHandle)|$shellPid|$wtFlag"
            } else {
                Write-Output $p.MainWindowHandle
            }
            exit
        }
    } catch {
        [Console]::Error.WriteLine("find-hwnd: depth=$i pid=$cur dead")
    }
    if (-not $map.ContainsKey($cur) -or $map[$cur] -eq 0) {
        [Console]::Error.WriteLine("find-hwnd: chain broken at pid=$cur")
        break
    }
    $cur = $map[$cur]
}
# Fallback: VSCode/Cursor integrated terminal injects VSCODE_GIT_IPC_HANDLE,
# a named pipe owned by the specific editor instance. Use GetNamedPipeServerProcessId
# to get the exact owner PID without any process-name guessing.
if ($env:VSCODE_GIT_IPC_HANDLE) {
    [Console]::Error.WriteLine("find-hwnd: trying VSCODE_GIT_IPC_HANDLE=$($env:VSCODE_GIT_IPC_HANDLE)")
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class PipeHelper {
    [DllImport("kernel32.dll", CharSet=CharSet.Auto, SetLastError=true)]
    static extern SafeFileHandle CreateFile(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr securityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeServerProcessId(SafeHandle hPipe, out uint ServerProcessId);
    public static int GetServerPid(string pipeName) {
        // GENERIC_READ|GENERIC_WRITE=0xC0000000, FILE_SHARE_READ|WRITE=3, OPEN_EXISTING=3
        SafeFileHandle h = CreateFile(pipeName, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h.IsInvalid) return -1;
        try { uint pid = 0; return GetNamedPipeServerProcessId(h, out pid) ? (int)pid : -1; }
        finally { h.Close(); }
    }
}
'@ -ErrorAction Stop
        $serverPid = [PipeHelper]::GetServerPid($env:VSCODE_GIT_IPC_HANDLE)
        [Console]::Error.WriteLine("find-hwnd: pipe server pid=$serverPid")
        if ($serverPid -gt 0) {
            $cur = $serverPid
            for ($i = 0; $i -lt 10; $i++) {
                try {
                    $p = Get-Process -Id $cur -ErrorAction Stop
                    [Console]::Error.WriteLine("find-hwnd: pipe-chain depth=$i pid=$cur name=$($p.ProcessName) hwnd=$($p.MainWindowHandle)")
                    if ($p.MainWindowHandle -ne 0) {
                        [Console]::Error.WriteLine("find-hwnd: found via pipe hwnd=$($p.MainWindowHandle)")
                        if ($IncludeShellPid) {
                            $wtFlag = if ($isWindowsTerminal) { '1' } else { '0' }
                            Write-Output "$($p.MainWindowHandle)|$shellPid|$wtFlag"
                        } else {
                            Write-Output $p.MainWindowHandle
                        }
                        exit
                    }
                } catch {
                    [Console]::Error.WriteLine("find-hwnd: pipe-chain depth=$i pid=$cur dead")
                }
                if (-not $map.ContainsKey($cur) -or $map[$cur] -eq 0) { break }
                $cur = $map[$cur]
            }
        }
    } catch {
        [Console]::Error.WriteLine("find-hwnd: pipe approach failed: $_")
    }
}
[Console]::Error.WriteLine("find-hwnd: not found, returning 0")
if ($IncludeShellPid) {
    $wtFlag = if ($isWindowsTerminal) { '1' } else { '0' }
    Write-Output "0|$shellPid|$wtFlag"
} else {
    Write-Output 0
}
