; REBRAND-GUPPY (1.1.82): the exe is renamed from "Munder Difflin.exe" to "Guppy.exe" (the Human,
; 2026-10-03). electron-builder includes this file in the NSIS installer (electron-builder.yml
; nsis.include).
;
; What electron-builder's own script already does on an in-app update (--updated) from 1.1.81, read
; from app-builder-lib 25.1.8 templates/nsis (installSection.nsh, include/installUtil.nsh,
; include/installer.nsh); test/rebrand-a-182.test.cjs pins it:
;   keepShortcuts is only "true" when "$INSTDIR\${APP_EXECUTABLE_FILENAME}" (= Guppy.exe) exists before
;   the copy, and in the old install folder it does not. So the old uninstaller runs WITHOUT
;   --keep-shortcuts and deletes "Munder Difflin.lnk" (Start menu and desktop), and this installer
;   creates "Guppy.lnk" in both places, aimed at Guppy.exe with the same AUMID (the unchanged appId).
;
; What it does not do: a TASKBAR PIN is a .lnk in the user's "User Pinned\TaskBar" folder, and it would
; keep pointing at the deleted Munder Difflin.exe. customInstall re-targets such links IN PLACE (same
; file name, so the pin stays where the user put it) to Guppy.exe with the app's AUMID. Only links named
; "Munder Difflin*.lnk" whose target is the old exe in THIS install folder are touched, so a pin of
; another copy (a portable one, say) is left alone. The same check runs over the desktop and the Start
; menu for any renamed copy of the old shortcut the stock step does not know about.
; The target is read with PowerShell (hidden, nsExec); if that fails, nothing is changed.

; REBRAND-UPDATER-BASE (1.1.83): electron-builder 25.1.8 passes APP_INSTALLER_STORE_FILE on the
; makensis command line as "<package name>-updater\installer.exe" (NsisTarget.js, appInfo
; updaterCacheDirName) = "munder-difflin-updater\installer.exe", and include/installer.nsh copies the
; running installer there ($LOCALAPPDATA) as the base for the next DIFFERENTIAL update. Since 1.1.82
; the app's updater cache is guppy-updater (afterPack-memory-prune.cjs writes app-update.yml), and
; electron-updater looks for the base in <cache>\installer.exe, so it never found one: every update
; downloaded in full, and each install left ~218 MB in munder-difflin-updater. This file is included
; BEFORE the template, so the define is replaced here, before installApplicationFiles uses it.
!define GUPPY_UPDATER_DIR "guppy-updater"
!define GUPPY_OLD_UPDATER_DIR "munder-difflin-updater"
!ifdef APP_INSTALLER_STORE_FILE
  !undef APP_INSTALLER_STORE_FILE
  !define APP_INSTALLER_STORE_FILE "${GUPPY_UPDATER_DIR}\installer.exe"
!endif
!ifndef GUPPY_LOCALAPPDATA
  !define GUPPY_LOCALAPPDATA "$LOCALAPPDATA"
!endif

; Once the new base is in place, the old one (and an update the old cache downloaded) is dropped.
; Explicit names only; RMDir without /r removes a folder only when it is empty. A file in use (the
; installer a 1.1.81 updater is running from pending\) cannot be deleted and simply stays.
!macro guppyDropOldUpdaterBase
  ${If} ${FileExists} "${GUPPY_LOCALAPPDATA}\${GUPPY_UPDATER_DIR}\installer.exe"
    Delete "${GUPPY_LOCALAPPDATA}\${GUPPY_OLD_UPDATER_DIR}\installer.exe"
    Delete "${GUPPY_LOCALAPPDATA}\${GUPPY_OLD_UPDATER_DIR}\pending\update-info.json"
    Delete "${GUPPY_LOCALAPPDATA}\${GUPPY_OLD_UPDATER_DIR}\pending\*.exe"
    RMDir "${GUPPY_LOCALAPPDATA}\${GUPPY_OLD_UPDATER_DIR}\pending"
    RMDir "${GUPPY_LOCALAPPDATA}\${GUPPY_OLD_UPDATER_DIR}"
    ClearErrors
  ${EndIf}
!macroend

; SCHEME-DROP (1.1.87, the Human 2026-10-15): guppy:// is the only link scheme. Up to 1.1.86 the app
; also answered munderdifflin://, and registered it itself at every start: on Windows
; app.setAsDefaultProtocolClient writes HKCU\Software\Classes\munderdifflin with
; shell\open\command = "<exe>" "%1". 1.1.87 no longer does, so the installer (customInstall) and the
; uninstaller (customUnInstall) delete that key, but ONLY when its command runs a Guppy.exe. A key
; that names another program (or a dev electron.exe) is left alone. HKCU only: this is all the app
; ever wrote. The tests override the key path (they never run the drop on the real registry).
!ifndef GUPPY_OLD_SCHEME_KEY
  !define GUPPY_OLD_SCHEME_KEY "Software\Classes\munderdifflin"
!endif

; OUT = "1" when CMD runs a Guppy.exe, else "0". The program is the quoted first token
; ("C:\...\Guppy.exe" "%1", Electron's form) or, unquoted, everything up to the first space; it must
; end in \Guppy.exe (any case: NSIS compares strings case-insensitively). An unterminated quote, a
; bare "Guppy.exe" or "Guppy.exe.bak" is not a match. OUT must not be $R0-$R4.
!macro guppyIsGuppyCommand CMD OUT
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $R0 "${CMD}"
  StrCpy $R1 "0"
  StrCpy $R2 $R0 1
  ${If} $R2 == '"'
    StrCpy $R0 $R0 "" 1
  ${Else}
    StrCpy $R2 " "
  ${EndIf}
  StrCpy $R3 0
  ${Do}
    StrCpy $R4 $R0 1 $R3
    ${If} $R4 == ""
      ${IfThen} $R2 == '"' ${|} StrCpy $R3 -1 ${|}
      ${ExitDo}
    ${EndIf}
    ${IfThen} $R4 == $R2 ${|} ${ExitDo} ${|}
    IntOp $R3 $R3 + 1
  ${Loop}
  ${If} $R3 >= 10
    StrCpy $R0 $R0 $R3
    StrCpy $R4 $R0 "" -10
    ${IfThen} $R4 == "\Guppy.exe" ${|} StrCpy $R1 "1" ${|}
  ${EndIf}
  StrCpy ${OUT} $R1
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro guppyDropOldScheme
  Push $0
  Push $1
  ClearErrors
  ReadRegStr $0 HKCU "${GUPPY_OLD_SCHEME_KEY}\shell\open\command" ""
  ${IfNot} ${Errors}
    !insertmacro guppyIsGuppyCommand $0 $1
    ${If} $1 == "1"
      DeleteRegKey HKCU "${GUPPY_OLD_SCHEME_KEY}"
      DetailPrint "Guppy: removed the old munderdifflin:// link handler"
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!define GUPPY_OLD_EXE "Munder Difflin.exe"
!ifndef GUPPY_PIN_DIR
  !define GUPPY_PIN_DIR "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
!endif

; Re-target every "Munder Difflin*.lnk" in DIR that points at "$INSTDIR\Munder Difflin.exe" to $appExe.
!macro guppyRetargetLinks DIR
  Push $0
  Push $1
  Push $2
  Push $3
  ClearErrors
  FindFirst $0 $1 "${DIR}\Munder Difflin*.lnk"
  ${DoWhile} $1 != ""
    System::Call 'Kernel32::SetEnvironmentVariable(t "GUPPY_LNK", t "${DIR}\$1")i'
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[Console]::Out.Write((New-Object -ComObject WScript.Shell).CreateShortcut($$env:GUPPY_LNK).TargetPath)"'
    Pop $2
    Pop $3
    ${If} $2 == 0
    ${AndIf} $3 == "$INSTDIR\${GUPPY_OLD_EXE}"
      CreateShortCut "${DIR}\$1" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "${DIR}\$1" "${APP_ID}"
      DetailPrint "Guppy: re-targeted ${DIR}\$1"
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "GUPPY_LNK", i 0)i'
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !insertmacro guppyRetargetLinks "${GUPPY_PIN_DIR}"
  !insertmacro guppyRetargetLinks "$DESKTOP"
  !insertmacro guppyRetargetLinks "$SMPROGRAMS"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ; REBRAND-UPDATER-BASE: the updater base lives in $LOCALAPPDATA of the user (as installer.nsh
  ; copies it), so switch to the current user's folders for an all-users install, as it does.
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  !insertmacro guppyDropOldUpdaterBase
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
  ; SCHEME-DROP: the old munderdifflin:// handler, when it is ours.
  !insertmacro guppyDropOldScheme
!macroend

!macro customUnInstall
  ; SCHEME-DROP: the same check on uninstall (a 1.1.86 or older run may have re-registered it).
  !insertmacro guppyDropOldScheme
!macroend
