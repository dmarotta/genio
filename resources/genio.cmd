@echo off
setlocal
set ELECTRON_RENDERER_URL=
set ELECTRON_RUN_AS_NODE=
rem Keep the caller's working directory so `genio .` opens that folder.
if exist "%~dp0..\Genio.exe" (
  "%~dp0..\Genio.exe" %*
) else (
  "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0.." %*
)
