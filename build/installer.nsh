!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing the HTTP FreeKit interception certificate and private data..."
    nsExec::ExecToLog '"$INSTDIR\resources\app.asar.unpacked\node_modules\node\bin\node.exe" "$INSTDIR\resources\app.asar.unpacked\src\windows-uninstall-cleanup.js" "$APPDATA\http-freekit\data"'
    Pop $0
    ${if} $0 != 0
      DetailPrint "HTTP FreeKit security-data cleanup failed with exit code $0; the data directory was preserved for recovery."
    ${endif}
  ${endif}
!macroend
