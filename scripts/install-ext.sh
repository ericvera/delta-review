#!/bin/sh
# Installs the packaged VSIX into VS Code, falling back to the app-bundle CLI
# when `code` is not on PATH (e.g. shells spawned without the shell command).
set -e
CODE="$(command -v code || true)"
if [ -z "$CODE" ]; then
  CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
fi
"$CODE" --install-extension delta-review.vsix --force
echo "Installed. Reload VS Code windows (Developer: Reload Window) to pick up the new version."
