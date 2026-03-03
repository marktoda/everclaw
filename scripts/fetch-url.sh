#!/bin/bash
# Fetch a URL and return its content.
# Input (JSON on stdin): {"url": "https://example.com", "raw": false}
# - url: URL to fetch (required)
# - raw: if true, return raw HTML; otherwise extract text with basic filtering
# Output: page content on stdout

set -euo pipefail

INPUT=$(cat)
URL=$(echo "$INPUT" | jq -r '.url // empty')
RAW=$(echo "$INPUT" | jq -r '.raw // false')

if [ -z "$URL" ]; then
  echo "Error: 'url' field is required" >&2
  exit 1
fi

if [ "$RAW" = "true" ]; then
  curl -sL --max-time 15 --max-filesize 1048576 "$URL"
else
  # Pipe through sed and head. SIGPIPE (141) from head closing early is normal.
  curl -sL --max-time 15 --max-filesize 1048576 "$URL" \
    | sed 's/<script[^>]*>.*<\/script>//g' \
    | sed 's/<style[^>]*>.*<\/style>//g' \
    | sed 's/<[^>]*>//g' \
    | sed '/^[[:space:]]*$/d' \
    | head -500 || true
fi
