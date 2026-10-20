@echo off
rem YOLO Annotator — Windows launcher (visible-console entry point).
rem
rem Normally started by yolo-annotator-hidden.vbs, which resolves the dataset and
rem passes "images-folder" and "classes-file" as %1 and %2.
setlocal EnableDelayedExpansion

set "DIR=%~dp0"
set "IMAGES=%~1"
set "CLASSES=%~2"

if "%IMAGES%"=="" (
  rem No dataset supplied yet: ask with the picker, then start through it again.
  cscript //nologo "%DIR%yolo-annotator-hidden.vbs"
  exit /b %ERRORLEVEL%
)

if "%CLASSES%"=="" (
  echo Usage: yolo-annotator.cmd "images-folder" "classes-file" [server options]
  echo.
  echo Run yolo-annotator-hidden.vbs to choose them with a dialog instead.
  pause
  exit /b 2
)

shift
shift
set "EXTRA="
:collect
if "%~1"=="" goto run
set "EXTRA=!EXTRA! %1"
shift
goto collect

:run
rem Any directory is fine; the dataset paths are absolute, so the working
rem directory only affects where relative paths would resolve.
cd /d "%USERPROFILE%\Documents"
"%DIR%node\node.exe" "%DIR%src\server\main.ts" "%IMAGES%" "%CLASSES%" !EXTRA!
