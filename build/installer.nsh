; Katacomb VPN's additions to electron-builder's NSIS installer (docs/windows.md).
;
; The service is the app's only door to root on Windows ([PH-12]), so the installer
; registers it and the uninstaller removes it, with everything it left behind: the
; tunnels, the kill switch, its routes and %ProgramData%\Katacomb VPN. Both run the
; helper the app ships, elevated (a per-machine install), through its `service` verbs
; ([PH-11]). customUnInstall runs before any file is deleted, while the helper the
; service runs from still exists; an upgrade runs the old uninstaller first, so the new
; installer registers its own helper again.

!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\win\privileged\katacomb-vpn-helper.exe" service install'
  Pop $0
  ${If} $0 != 0
    DetailPrint "The Katacomb VPN service could not be installed (exit code $0)."
    MessageBox MB_OK|MB_ICONEXCLAMATION "The Katacomb VPN service could not be installed (exit code $0). The app can't connect without it: run this installer again." /SD IDOK
    SetErrorLevel 2
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\resources\win\privileged\katacomb-vpn-helper.exe" service uninstall'
  Pop $0
  ${If} $0 != 0
    DetailPrint "The Katacomb VPN service could not be removed (exit code $0)."
  ${EndIf}
!macroend
