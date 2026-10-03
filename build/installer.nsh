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
!macroend
