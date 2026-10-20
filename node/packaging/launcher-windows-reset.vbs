' Forgets the remembered dataset and opens the pickers again.
'
' A .lnk cannot pass arguments in a way the main launcher sees, so this drops a
' sentinel file the launcher checks for, then starts the launcher.
Option Explicit

Dim shell, fso, here, configDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
configDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\YOLO Annotator"
If Not fso.FolderExists(configDir) Then fso.CreateFolder(configDir)

Dim sentinel
sentinel = configDir & "\forget-dataset"
Dim out
Set out = fso.CreateTextFile(sentinel, True)
out.WriteLine "1"
out.Close

shell.Run """" & here & "\yolo-annotator-hidden.vbs""", 0, False
