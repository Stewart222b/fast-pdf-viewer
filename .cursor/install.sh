#!/usr/bin/env bash
set -euo pipefail

# Idempotent Cloud Agent bootstrap for Fast PDF Viewer – AI Translation.
# Runs after the repository is checked out. Safe to run repeatedly.

cd "$(dirname "$0")/.."

python3 -m pip install --user -r requirements.txt

# pdf.js assets live under web/vendor/pdfjs (gitignored). Only fetch them when
# missing so reruns stay offline and fast.
if [ ! -f web/vendor/pdfjs/VERSION ] || [ ! -f web/vendor/pdfjs/build/pdf.mjs ]; then
  python3 desktop/bootstrap_pdfjs.py
fi

# Regenerate the tiny sample PDF used for local testing.
python3 desktop/make_sample.py
