# Register erica-s.claude-code-notify.activate-window:// protocol handler
# Uses VBScript wrapper to completely hide PowerShell window

# Get the full path to activate-window.vbs
$vbsPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "activate-window.vbs"))

# Build the command string: wscript.exe runs VBScript which then invokes PowerShell
# Using wscript (GUI-based) instead of cscript to avoid any console window
$command = "wscript.exe `"$vbsPath`" `"%1`""

# Write registry entries
$regPath = "HKCU:\Software\Classes\erica-s.claude-code-notify.activate-window"
New-Item -Path "$regPath\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(default)" -Value "URL:Claude Code Activate Window Protocol" -Force
New-ItemProperty -Path $regPath -Name "URL Protocol" -Value "" -Force -ErrorAction SilentlyContinue | Out-Null
Set-ItemProperty -Path "$regPath\shell\open\command" -Name "(default)" -Value $command -Force

Write-Host "Protocol registered: erica-s.claude-code-notify.activate-window"
