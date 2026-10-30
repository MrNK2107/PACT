#!/usr/bin/env bash
# Progress of the newest acceptance run matching a prefix: sim time, deliveries, auth rejects.
d=$(ls -td /tmp/aeropact_${1:-px4}* 2>/dev/null | head -1)
echo "run: $d"
[ -f "$d/events.jsonl" ] || exit 0
tail -1 "$d/events.jsonl" | grep -o '"t":[0-9.]*'
echo "delivered: $(grep -c '"DELIVERED"' "$d/events.jsonl")"
echo "radio_auth_reject: $(grep -c RADIO_AUTH_REJECT "$d/events.jsonl")"
