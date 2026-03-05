# Claude Code Window Activator
# Usage: Called by custom.claude-code.activate-window:// protocol handler
param([string]$Url)

# Write debug info to temp file
$debugFile = "$env:TEMP\claude-activate-debug.log"
"[$(Get-Date)] URL received: $Url" | Out-File -FilePath $debugFile -Append

# Extract window handle from URL and clean it
$handleString = $Url -replace 'custom.claude-code.activate-window://', '' -replace '/', '' -replace '\\', ''
$handleString = $handleString.Trim()
"[$(Get-Date)] Handle string (cleaned): $handleString" | Out-File -FilePath $debugFile -Append

try {
    # Convert string to integer, then to IntPtr
    $handleInt = [int]$handleString
    $hwnd = [IntPtr]$handleInt
    "[$(Get-Date)] Parsed handle: $hwnd (from int: $handleInt)" | Out-File -FilePath $debugFile -Append
} catch {
    "[$(Get-Date)] Failed to parse handle: $_" | Out-File -FilePath $debugFile -Append
    exit 1
}

# Define Windows API for window activation
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    public const int SW_RESTORE = 9;
}
'@ -ErrorAction SilentlyContinue

# Verify the window handle is valid
if (-not [WinAPI]::IsWindow($hwnd)) {
    "[$(Get-Date)] Invalid window handle: $hwnd" | Out-File -FilePath $debugFile -Append
    exit 1
}

# Activate the window
try {
    # Only restore if window is minimized (iconic)
    $isMinimized = [WinAPI]::IsIconic($hwnd)
    if ($isMinimized) {
        $showResult = [WinAPI]::ShowWindow($hwnd, 9)  # Restore from minimized state
        "[$(Get-Date)] Window was minimized, restored. ShowWindow result: $showResult" | Out-File -FilePath $debugFile -Append
    } else {
        "[$(Get-Date)] Window is not minimized, skipping restore" | Out-File -FilePath $debugFile -Append
    }

    # Always bring to foreground
    $foregroundResult = [WinAPI]::SetForegroundWindow($hwnd)
    "[$(Get-Date)] SetForegroundWindow result: $foregroundResult" | Out-File -FilePath $debugFile -Append
} catch {
    "[$(Get-Date)] Activation failed: $_" | Out-File -FilePath $debugFile -Append
}
