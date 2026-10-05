# Keep launch-after-install independent of Start Menu shortcuts.
# electron-builder still creates shortcuts and passes --updated as before.
!macro customInstall
  StrCpy $launchLink "$appExe"
!macroend
