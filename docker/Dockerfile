# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build the frontend ----------
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: python runtime ----------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 app
WORKDIR /app

COPY backend/pyproject.toml ./backend/pyproject.toml
COPY backend/app ./backend/app
# Ship the dev-tools scenario presets as part of the image so the
# scenario picker isn't empty inside Docker. The scenarios are tiny
# (<10 KB) and only loaded when ``DEV_TOOLS_ENABLED=true``; the gate
# stays closed by default in production builds. Without this COPY
# the auto-resolved ``<repo_root>/backend/scenarios`` directory
# inside the container ends up missing and the picker silently
# returns an empty list.
COPY backend/scenarios ./backend/scenarios
# Upgrade pip before any install: the bundled pip in python:3.12-slim
# (25.0.1 at time of writing) ships CVE-2025-8869 (symlink-extraction
# check missing) and a related path-traversal info-disclosure CVE,
# both fixed in pip 25.3. The Trivy gate in docker.yml flags these
# on every push; rather than .trivyignore them, just take the patched
# pip — it's a five-second image-size-neutral fix.
RUN pip install --upgrade "pip>=25.3"
RUN pip install -e ./backend

# Copy built frontend into the location the backend serves static files from
COPY --from=frontend-build /build/dist ./backend/app/static

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "backend"]
