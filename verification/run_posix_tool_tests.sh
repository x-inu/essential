#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
exec python3 -m unittest -v verification/posix_tools_test.py
