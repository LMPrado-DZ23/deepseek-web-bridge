' Inicia a ponte DeepSeek Web em segundo plano, sem janela visivel.
' Usado pelo atalho de inicializacao do Windows (autostart.ps1).
' Se a ponte ja estiver respondendo em 127.0.0.1:8787, nao inicia outra.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.open "GET", "http://127.0.0.1:8787/health", False
http.send
If Err.Number = 0 Then
  If http.Status = 200 Then
    WScript.Quit 0
  End If
End If
Err.Clear
On Error GoTo 0

sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c start.cmd", 0, False
