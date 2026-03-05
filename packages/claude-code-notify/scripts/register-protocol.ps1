$regPath = "HKCU:\Software\Classes\custom.claude-code.activate-window"
New-Item -Path "$regPath\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(default)" -Value "URL:Claude Code Activate Window Protocol" -Force
New-ItemProperty -Path $regPath -Name "URL Protocol" -Value "" -Force -ErrorAction SilentlyContinue | Out-Null
$vbsPath = "$env:USERPROFILE\.claude\scripts\claude-notify\activate-window-silent.vbs"
Set-ItemProperty -Path "$regPath\shell\open\command" -Name "(default)" -Value "wscript.exe ""$vbsPath"" ""%1""" -Force
Write-Host "Protocol registered: custom.claude-code.activate-window"
Write-Host ""
Write-Host "Note: Run setup.bat for complete installation."
