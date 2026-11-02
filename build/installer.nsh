; Custom NSIS hooks (included via nsis.include in electron-builder.yml).
;
; Registers the cipherway:// URL scheme for subscription import links
; (cipherway://import?url=... / cipherway://install-config?url=...).
; electron-builder 25 does not apply `protocols` to NSIS targets on Windows.
; SHCTX = HKCU for a per-user install (perMachine: false), HKLM otherwise.

!macro customInstall
  DeleteRegKey SHCTX "Software\Classes\cipherway"
  WriteRegStr SHCTX "Software\Classes\cipherway" "" "URL:CipherWay VPN"
  WriteRegStr SHCTX "Software\Classes\cipherway" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\cipherway\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\cipherway\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; keep the scheme during auto-updates (the old uninstaller runs first)
  ${ifNot} ${isUpdated}
    DeleteRegKey SHCTX "Software\Classes\cipherway"
  ${endIf}
!macroend
