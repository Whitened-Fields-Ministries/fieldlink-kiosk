; electron-builder NSIS hooks for FieldLinkKiosk.
;
; On a real uninstall (not an in-place upgrade) undo kiosk mode first, so a PC
; is never left auto-logging into an account whose shell no longer exists.
; kiosk-admin.ps1 -Action Unlock is idempotent and harmless on a PC that was
; never locked down.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing FieldLink kiosk mode (auto-login, locked shell, update task)…"
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\kiosk-admin.ps1" -Action Unlock'
    Pop $0
  ${endIf}
!macroend
