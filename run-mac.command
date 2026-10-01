#!/bin/bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terinstall. Install dulu dari https://nodejs.org/en/download"
  exit 1
fi

[ -d node_modules ] || npm install
node generator.mjs "$@"
