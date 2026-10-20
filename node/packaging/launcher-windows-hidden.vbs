' YOLO Annotator — Windows launcher without a console window.
'
' Windows Script Host runs this invisibly. It resolves a dataset (saved choice,
' or the conventional Documents folder, or by asking with real Windows pickers),
' writes the choice down, then starts the bundled server via the .cmd.
Option Explicit

Dim shell, fso, here, configDir, configFile, images, classes, defaultData, resetRequested
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
configDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\YOLO Annotator"
configFile = configDir & "\dataset.conf"
defaultData = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\YOLO Annotator"

If Not fso.FolderExists(configDir) Then fso.CreateFolder(configDir)

images = ""
classes = ""
resetRequested = WasReset()

' ---------------------------------------------------------------- preferences
' A sentinel file lets a shortcut ask for the pickers without needing arguments.
Dim forgetFile
forgetFile = configDir & "\forget-dataset"
If fso.FileExists(forgetFile) Then
  fso.DeleteFile forgetFile, True
  resetRequested = True
End If

If fso.FileExists(configFile) And Not resetRequested Then
  Dim stream, line, parts
  Set stream = fso.OpenTextFile(configFile, 1)
  Do Until stream.AtEndOfStream
    line = stream.ReadLine
    If Left(line, 7) = "images=" Then images = Mid(line, 8)
    If Left(line, 8) = "classes=" Then classes = Mid(line, 9)
  Loop
  stream.Close
End If

' A remembered dataset that has since moved or been deleted is not usable.
If images <> "" Then
  If Not (fso.FolderExists(images) And fso.FileExists(classes)) Then
    images = ""
    classes = ""
  End If
End If

' The conventional folder is used without asking, if it already has images.
If images = "" Then
  If fso.FolderExists(defaultData & "\images") And fso.FileExists(defaultData & "\obj.names") Then
    If HasImages(defaultData & "\images") Then
      images = defaultData & "\images"
      classes = defaultData & "\obj.names"
    End If
  End If
End If

' -------------------------------------------------------------------- pickers
If images = "" Then
  Dim picked
  picked = AskWithPowerShell()
  If picked = "" Then
    WScript.Quit 0            ' the user cancelled
  End If
  parts = Split(picked, vbLf)
  If UBound(parts) < 1 Then WScript.Quit 0
  images = Trim(parts(0))
  classes = Trim(parts(1))

  If Not (fso.FolderExists(images) And fso.FileExists(classes)) Then
    MsgBox "That selection could not be read." & vbCrLf & vbCrLf & _
           "Choose a folder for the images and a file for the classes.", _
           48, "YOLO Annotator"
    WScript.Quit 1
  End If

  Dim out
  Set out = fso.CreateTextFile(configFile, True)
  out.WriteLine "images=" & images
  out.WriteLine "classes=" & classes
  out.Close
End If

' --------------------------------------------------------------------- server
shell.Run """" & here & "\yolo-annotator.cmd"" """ & images & """ """ & classes & """", 0, False

' -------------------------------------------------------------------- helpers
Function WasReset()
  Dim i
  WasReset = False
  For i = 0 To WScript.Arguments.Count - 1
    If LCase(WScript.Arguments(i)) = "--reset" Then WasReset = True
  Next
End Function

Function HasImages(folder)
  Dim f
  HasImages = False
  For Each f In fso.GetFolder(folder).Files
    Dim ext
    ext = LCase(fso.GetExtensionName(f.Name))
    If ext = "jpg" Or ext = "jpeg" Or ext = "png" Or ext = "bmp" Or _
       ext = "webp" Or ext = "tif" Or ext = "tiff" Then
      HasImages = True
      Exit Function
    End If
  Next
End Function

' Folder and file pickers via PowerShell: the .NET dialogs are available on
' every supported Windows and return clean POSIX-free paths.
Function AskWithPowerShell()
  Dim ps, exec, script
  script = "$ErrorActionPreference='Stop';" & _
    "Add-Type -AssemblyName System.Windows.Forms;" & _
    "$f=New-Object System.Windows.Forms.FolderBrowserDialog;" & _
    "$f.Description='Select the folder that contains your images';" & _
    "if($f.ShowDialog() -ne 'OK'){exit 2};" & _
    "$o=New-Object System.Windows.Forms.OpenFileDialog;" & _
    "$o.Title='Select your classes file (for example obj.names)';" & _
    "$o.Filter='Classes (*.names;*.txt)|*.names;*.txt|All files (*.*)|*.*';" & _
    "if($o.ShowDialog() -ne 'OK'){exit 2};" & _
    "Write-Output $f.SelectedPath; Write-Output $o.FileName"
  ps = "powershell.exe -NoProfile -STA -Command " & Chr(34) & script & Chr(34)
  On Error Resume Next
  Set exec = shell.Exec(ps)
  If Err.Number <> 0 Then
    AskWithPowerShell = ""
    Exit Function
  End If
  Dim text
  text = exec.StdOut.ReadAll
  If exec.ExitCode <> 0 Then
    AskWithPowerShell = ""
  Else
    AskWithPowerShell = Replace(text, vbCrLf, vbLf)
  End If
  On Error GoTo 0
End Function
