@echo off
setlocal
set "APP=%~dp0bin\win32\x64\win-unpacked\Fluent Reader Custom.exe"
if not exist "%APP%" (
  echo Build not found. Run npm ci, npm run build, and npm run package-custom first.
  pause
  exit /b 1
)
start "" "%APP%"
