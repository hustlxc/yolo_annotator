; NSIS installer for the Windows YOLO Annotator.
;
; Chosen over Inno Setup because NSIS compiles on macOS, so the .exe can be
; produced without a Windows machine.
;
; Build:
;   makensis /DVERSION=2.0.0 /DSRCDIR=..\dist\yolo-annotator /DOUTDIR=..\dist packaging\installer.nsi

Unicode true

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef SRCDIR
  !define SRCDIR "..\dist\yolo-annotator"
!endif
!ifndef OUTDIR
  !define OUTDIR "..\dist"
!endif

!define APPNAME "YOLO Annotator (browser)"
!define PUBLISHER "YOLO Annotator"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\YOLOAnnotator"

Name "${APPNAME}"
; Deliberately different from the desktop installer, which is the one most
; people want. Sharing a filename made the wrong build easy to install.
OutFile "${OUTDIR}\YOLO-Annotator-BROWSER-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APPNAME}"
InstallDirRegKey HKLM "Software\YOLOAnnotator" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\yolo-annotator-hidden.vbs"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APPNAME}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ----------------------------------------------------------------- payload
Section "Application" SecApp
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; node\, src\, web\, yolo-annotator.cmd, the hidden-launch helper, README.txt
  File /r "${SRCDIR}\*.*"

  ; Remember where we installed, for upgrades and uninstall.
  WriteRegStr HKLM "Software\YOLOAnnotator" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Start Menu shortcut" SecStartMenu
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  ; The .vbs keeps the console window hidden; the .cmd does the real work.
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\yolo-annotator-hidden.vbs" "" "$INSTDIR\yolo-annotator.cmd" 0
  ; Opens the folder/file pickers again, ignoring the remembered dataset. The
  ; sentinel file is how a shortcut communicates this to the launcher.
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME} (choose folder).lnk" "$INSTDIR\yolo-annotator-reset.vbs" "" "$INSTDIR" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\yolo-annotator-hidden.vbs" "" "$INSTDIR\yolo-annotator.cmd" 0
SectionEnd

; ------------------------------------------------------------------ uninstall
Section "Uninstall"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME} (choose folder).lnk"
  Delete "$INSTDIR\yolo-annotator-reset.vbs"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"

  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\web"
  Delete "$INSTDIR\yolo-annotator.cmd"
  Delete "$INSTDIR\yolo-annotator-hidden.vbs"
  Delete "$INSTDIR\yolo-annotator-reset.vbs"
  Delete "$INSTDIR\obj.names"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\package.json"
  RMDir "$INSTDIR\images"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "${UNINSTKEY}"
  DeleteRegKey HKLM "Software\YOLOAnnotator"

  ; The user's dataset in Documents is deliberately left untouched.
SectionEnd
