' VBScript wrapper to completely hide PowerShell window
' When invoked via URL protocol, this script runs PowerShell without any window flash

Dim shell, scriptPath, psCommand

Set shell = CreateObject("WScript.Shell")

' Get the directory where this script is located
scriptPath = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
psCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & scriptPath & "activate-window.ps1"" """ & WScript.Arguments(0) & """"

' Run with window style 0 = completely hidden
shell.Run psCommand, 0, False
