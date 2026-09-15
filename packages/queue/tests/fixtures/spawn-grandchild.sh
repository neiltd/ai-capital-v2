#!/bin/bash
# Harmless fixture: starts a long `sleep` GRANDCHILD, records its PID, and waits.
# Used to prove a signal reaches the whole process tree rather than only the
# immediate child. Touches no database, no queue and no network.
out="$1"
sleep 120 &
grandchild=$!
echo "$grandchild" > "$out"
wait "$grandchild"
