#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing backend dev dependencies"
python -m pip install --upgrade pip
python -m pip install -e "backend[dev]"

echo "==> Installing frontend dependencies"
pushd frontend >/dev/null
npm ci
popd >/dev/null

echo "==> Done. Run 'uvicorn app.main:app --reload --app-dir backend' for backend, 'npm run dev' (in frontend/) for the UI."
