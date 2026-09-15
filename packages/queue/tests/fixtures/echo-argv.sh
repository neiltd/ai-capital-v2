#!/bin/bash
# Harmless fixture: writes each argument it received, one per line, to $1's file.
# Used to prove the launcher passes arguments through byte-for-byte, including
# empty ones. Touches no database, no queue and no network.
out="$1"; shift
: > "$out"
for a in "$@"; do printf '[%s]\n' "$a" >> "$out"; done
