' War - one-click launcher.
'
' Starts the dev server with no console window and opens the browser on the
' port Vite actually bound. The URL is read back out of the server's own
' output rather than assumed: Vite falls back to a free port when its default
' is taken, and a hard-coded address would open a dead tab whenever it is.

Option Explicit

Dim shell, fso, root, logPath, url, tries, ts, txt

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

logPath = fso.GetSpecialFolder(2) & "\war-dev.log"
On Error Resume Next
If fso.FileExists(logPath) Then fso.DeleteFile logPath, True
On Error GoTo 0

If Not fso.FolderExists(root & "\node_modules") Then
  ' First run only. Installing takes a minute or so; wait for it to finish.
  shell.Run "cmd /c npm install > """ & logPath & """ 2>&1", 0, True
End If

' 0 hides the console window, False means do not wait -- the server stays up.
shell.Run "cmd /c npm run dev > """ & logPath & """ 2>&1", 0, False

url = ""
For tries = 1 To 120
  WScript.Sleep 500
  If fso.FileExists(logPath) Then
    txt = ""
    On Error Resume Next
    Set ts = fso.OpenTextFile(logPath, 1)
    If Err.Number = 0 Then
      txt = ts.ReadAll
      ts.Close
    End If
    On Error GoTo 0
    url = FindUrl(StripAnsi(txt))
    If url <> "" Then Exit For
  End If
Next

If url = "" Then
  MsgBox "The server did not start within a minute." & vbCrLf & vbCrLf & _
         "Details are in:" & vbCrLf & logPath, 16, "War"
  WScript.Quit 1
End If

shell.Run url, 1, False

' Vite colourises its banner, and it wraps the PORT in its own escape sequence:
' "http://localhost:" ESC[1m "5180". Parsing the raw text therefore yields an
' address with no port at all, which opens a dead tab. Strip the escapes first.
Function StripAnsi(text)
  Dim out, i, ch
  out = ""
  i = 1
  Do While i <= Len(text)
    ch = Mid(text, i, 1)
    If ch = Chr(27) Then
      i = i + 1
      Do While i <= Len(text)
        ch = Mid(text, i, 1)
        If (ch >= "A" And ch <= "Z") Or (ch >= "a" And ch <= "z") Then Exit Do
        i = i + 1
      Loop
      i = i + 1
    Else
      out = out & ch
      i = i + 1
    End If
  Loop
  StripAnsi = out
End Function

' Pull the first localhost URL out of the banner, and insist it carries a port.
' Returning a portless address is the one failure worth guarding against here.
Function FindUrl(text)
  Dim at, j, ch, acc, digits
  FindUrl = ""
  If IsEmpty(text) Then Exit Function
  at = InStr(text, "http://localhost:")
  If at = 0 Then Exit Function
  acc = ""
  For j = at To Len(text)
    ch = Mid(text, j, 1)
    If ch = " " Or ch = vbTab Or ch = vbCr Or ch = vbLf Then Exit For
    acc = acc & ch
  Next
  digits = Mid(acc, Len("http://localhost:") + 1)
  If Len(digits) = 0 Then Exit Function
  If Not IsNumeric(Left(digits, 1)) Then Exit Function
  FindUrl = acc
End Function
