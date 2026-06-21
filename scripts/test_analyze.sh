#!/usr/bin/env bash
set -euo pipefail

URL=${1:-http://localhost:5050/api/analyze}
FILE=${2:-client/sample.pdf}
COUNT=${3:-3}

if [ ! -f "$FILE" ]; then
  echo "File $FILE not found. Provide a PDF file or run: cd client && curl -sS -o sample.pdf https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
  exit 1
fi

for i in $(seq 1 "$COUNT"); do
  echo "Upload $i/$COUNT -> $URL"
  curl -s -w "\nHTTP_CODE:%{http_code}\n" -F "file=@${FILE}" "$URL" -o /tmp/analyze_resp_${i}.json
  cat /tmp/analyze_resp_${i}.json || true
  echo
  sleep 1
done
