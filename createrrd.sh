#!/usr/bin/env bash
set -euo pipefail
# Use a new directory so running this script cannot erase existing history.
if [[ $# -ne 1 ]]; then
    echo "Usage: $0 NEW_OUTPUT_DIRECTORY" >&2
    exit 2
fi
exec python3 "$(dirname "$(realpath "$0")")/rrd-rebuild.py" --create-only --output "$1"
