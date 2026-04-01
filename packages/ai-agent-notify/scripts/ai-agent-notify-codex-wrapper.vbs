Option Explicit

Dim shell
Dim env
Dim command
Dim comspec
Dim exitCode
Dim payload

If WScript.Arguments.Count < 1 Then
    WScript.Quit 1
End If

payload = WScript.Arguments.Item(0)

Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("Process")
comspec = shell.ExpandEnvironmentStrings("%ComSpec%")

env("AI_AGENT_NOTIFY_PAYLOAD") = payload
command = comspec & " /d /c ai-agent-notify.cmd"
exitCode = shell.Run(command, 0, True)
If exitCode = 9009 Then
    command = comspec & " /d /c npx.cmd @erica-s/ai-agent-notify"
    exitCode = shell.Run(command, 0, True)
End If
env("AI_AGENT_NOTIFY_PAYLOAD") = ""

WScript.Quit exitCode
