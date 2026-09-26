#!/bin/zsh
# Package src/ into a distributable .alfredworkflow
set -euo pipefail
cd "${0:A:h}"
version=$(/usr/libexec/PlistBuddy -c 'Print :version' src/info.plist)
mkdir -p dist
out="dist/alfred-downloads-${version}.alfredworkflow"
rm -f "$out"
(cd src && zip -qr "../$out" . -x '.*' -x '__MACOSX')
echo "Built $out"
