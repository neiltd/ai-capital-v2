#!/bin/bash
# Harmless fixture: creates a marker file, proving a child was actually created.
# Used as the NEGATIVE control for credential validation: when validation fails,
# this file must not exist. Touches no database, no queue and no network.
printf 'ran\n' > "$1"
