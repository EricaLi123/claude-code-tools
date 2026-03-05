' Silent launcher for activate-window.ps1
' This avoids Windows Terminal from opening
Set objShell = CreateObject("WScript.Shell")
Set objArgs = WScript.Arguments

If objArgs.Count > 0 Then
    url = objArgs(0)
    userProfile = objShell.ExpandEnvironmentStrings("%USERPROFILE%")
    scriptPath = userProfile & "\.claude\scripts\claude-notify\activate-window.ps1"
    cmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -NonInteractive -File """ & scriptPath & """ """ & url & """"
    objShell.Run cmd, 0, False
End If
