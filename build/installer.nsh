; Custom NSIS behaviour for the EyerStock installer/uninstaller.
;
; electron-builder includes this file inside both the installer and the generated
; uninstaller, and expands it as macro bodies. That context does not have
; LogicLib available, so this file deliberately uses only core NSIS
; instructions - StrCmp, MessageBox, labels - and no ${...} logic macros. Adding
; `!include "LogicLib.nsh"` here fails the build with "Invalid command".
;
; The one plugin macro used here is `StdUtils.TestParameter`, which is how
; electron-builder's own generated script asks "was this started with
; --updated?". It is a plugin call rather than a logic macro, and it is
; available because the same header that includes this file includes StdUtils.
;
; The reason this file exists at all: the uninstaller should ASK whether to keep
; the shop's data. electron-builder's `deleteAppDataOnUninstall` is a
; compile-time boolean - it can only ever be "always keep" or "always delete",
; never "ask". Asking is a macro, so the macro is written here and the flag is
; left off so it never silently does either.
;
; Running processes are handled by electron-builder's own CHECK_APP_RUNNING
; before this macro runs. It closes EyerStock gracefully, retries, and only then
; force-kills it. Do not add a second process check here: a custom tasklist
; check previously aborted the uninstall whenever EyerStock was *not* running
; (its StrCmp was inverted), which made the uninstaller fail every time.

!macro customUnInstall
  ; An update is not an uninstall.
  ;
  ; The in-app updater runs this uninstaller with --updated: the application
  ; is being replaced, not removed. Nothing is asked and no data is touched -
  ; the shop's ledger, stock history and backups stay exactly where they are.
  ;
  ; Without this, an update would stop dead on the "keep your data?" question
  ; (the updater installs silently, so nobody is there to answer it).
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" eyerstock_uninstall_done

  ; Default to keeping the data. A shop's ledger, stock history and service
  ; records are irreplaceable, and an uninstall is usually an upgrade, not a
  ; decision to destroy three years of trading. `/SD IDYES` means a silent
  ; uninstall (an automated removal) also keeps the data.
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove EyerStock only, and keep your data (products, invoices, customers and backups)?$\r$\n$\r$\nChoose No if you also want to delete the data folder." /SD IDYES IDYES eyerstock_uninstall_done

  ; The user explicitly chose No: remove only this app's own data folders.
  ; Both the current name and the one the app shipped under before it was
  ; renamed to EyerStock, because an upgraded install may still be on the old
  ; folder. The updater cache is derived from the npm package name, which
  ; changed at the same time.
  RMDir /r "$APPDATA\EyerStock"
  RMDir /r "$APPDATA\eyerstock"
  RMDir /r "$APPDATA\Minha Inventory"
  RMDir /r "$LOCALAPPDATA\eyerstock-updater"
  RMDir /r "$LOCALAPPDATA\minha-inventory-updater"
  DetailPrint "Application data removed."

  eyerstock_uninstall_done:
!macroend

!macro customInstall
  ; Windows uses InstallLocation in the Apps & Features entry for diagnostics
  ; and management tools. electron-builder writes it only to the app's own
  ; registry key, so mirror it into the uninstall entry as well.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"

  ; The updater starts the installer with --updated as well, so the same
  ; question answers "is this an update?" on both sides.
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" eyerstock_install_done

  DetailPrint "EyerStock installed for the current user only."

  eyerstock_install_done:
!macroend
