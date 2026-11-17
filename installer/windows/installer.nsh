; Klara Wisper's additions to electron-builder's one-click NSIS installer (electron-builder.config.cjs: nsis.include).
; Saved as UTF-8 with a BOM, so NSIS reads the Hebrew text correctly.
;
;   customInit       before installing: refuse 32-bit Windows and anything older than Windows 10, with a
;                    message in Hebrew and English (the app needs 64-bit Windows 10/11).
;   customUnInstall  on a real uninstall (not an update): "Klara Wisper.exe --cleanup" takes out what the
;                    app added outside its own folders: the Claude Desktop / Claude Code connection, the
;                    Claude skills and the login item, and stops the engine Claude may have started.
;                    The data folder (%APPDATA%\Klara Wisper: engine, models, settings) is then deleted by
;                    deleteAppDataOnUninstall. Transcripts in Documents\Klara Wisper are kept.

!macro customInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Klara Wisper צריכה Windows של 64 ביט.$\r$\n$\r$\nKlara Wisper needs 64-bit Windows." /SD IDOK
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Klara Wisper צריכה Windows 10 או Windows 11.$\r$\n$\r$\nKlara Wisper needs Windows 10 or Windows 11." /SD IDOK
    Quit
  ${EndIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The pause lets Chromium's helper processes of that run close their files in the data folder.
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 +3
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cleanup'
      Sleep 2000
  ${endIf}
!macroend
