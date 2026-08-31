' Stops the hidden server started by "Play War.vbs".
'
' Scoped to THIS project by matching the folder path in each process command
' line. Matching on "vite" or killing every node.exe would be simpler and would
' also take down every other dev server on the machine -- which, on a developer
' box, is usually several.

Option Explicit

Dim shell, fso, root, wmi, procs, proc, killed, cmdline
killed = 0

Set fso = CreateObject("Scripting.FileSystemObject")
root = LCase(fso.GetParentFolderName(WScript.ScriptFullName))

On Error Resume Next
Set wmi = GetObject("winmgmts:")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
For Each proc In procs
  cmdline = proc.CommandLine
  If Not IsNull(cmdline) Then
    If InStr(LCase(cmdline), root) > 0 Then
      proc.Terminate()
      killed = killed + 1
    End If
  End If
Next
On Error GoTo 0

If killed = 0 Then
  MsgBox "No running War server was found." & vbCrLf & vbCrLf & _
         "Other projects' servers were left alone.", 64, "War"
Else
  MsgBox "Stopped " & killed & " War server process(es)." & vbCrLf & vbCrLf & _
         "Other projects' servers were left alone.", 64, "War"
End If
