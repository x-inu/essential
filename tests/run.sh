#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
exec python3 -m unittest -v tests/test_posix_tools.py
