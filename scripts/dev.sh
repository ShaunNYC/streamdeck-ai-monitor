#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npm run mode:ai
npm run dev --workspace=@streamdeck-supervisor/daemon
