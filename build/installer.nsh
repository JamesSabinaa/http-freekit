!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Restoring HTTP FreeKit proxy settings and removing its certificate and private data..."
    nsExec::ExecToLog '"$INSTDIR\resources\app.asar.unpacked\node_modules\node\bin\node.exe" "$INSTDIR\resources\app.asar.unpacked\src\windows-uninstall-cleanup.js" "$APPDATA\http-freekit\data"'
    Pop $0
    ${if} $0 != 0
      DetailPrint "HTTP FreeKit security-data cleanup failed with exit code $0; the data directory was preserved for recovery."
      Abort "HTTP FreeKit cleanup is incomplete. Close running FreeKit sessions and retry uninstall. The application and recovery data have been retained."
    ${endif}
  ${endif}
!macroend
