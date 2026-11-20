#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
    echo 'Cài Node.js 24 LTS từ https://nodejs.org/en/download rồi mở lại file này.'
    exit 1
fi
exec node scripts/local-binance.js
