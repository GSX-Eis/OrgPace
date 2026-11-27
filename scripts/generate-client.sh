#! /usr/bin/env bash

set -euo pipefail

force=${GENERATE_CLIENT_FORCE:-0}
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) echo "Usage: bash scripts/generate-client.sh [--force]" >&2; exit 2 ;;
  esac
done

formatted=$(mktemp -d)
trap 'rm -rf "$formatted"' EXIT
(cd backend && FASTAPI_ENV=development uv run python -c "import app.main; import json; print(json.dumps(app.main.app.openapi()))") > "$formatted/openapi.json"

if [[ $force != 1 && -f frontend/openapi.json && -f frontend/src/client/sdk.gen.ts && -f frontend/src/client/types.gen.ts && -f frontend/src/client/index.ts ]]; then
  if python3 - "$formatted/openapi.json" frontend/openapi.json <<'PY'
import json
import sys
from pathlib import Path

try:
    new_schema = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cur_schema = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    sys.exit(1)
sys.exit(0 if new_schema == cur_schema else 1)
PY
  then
    echo "OpenAPI schema unchanged; skipping frontend client generation."
    exit 0
  fi
fi

set -x
mv "$formatted/openapi.json" frontend/
bun run --filter frontend generate-client
# Stage the files outside src/client so Biome can format them with the frontend config.
cp frontend/src/client/*.ts "$formatted/"
(cd frontend && bunx biome format --write openapi.json "$formatted"/*.ts)
mv "$formatted"/*.ts frontend/src/client/
