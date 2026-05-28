# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build the frontend ----------
FROM node:25-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: python runtime ----------
# Pinned to 3.13-slim, NOT 3.14-slim, because litellm — our single
# LLM transport — has ``requires_python = "<3.14,>=3.10"`` on every
# release through 1.87.0rc2 (latest stable 1.86.2 at time of writing,
# 2026-05). On 3.14, pip backtracks to litellm 1.83.0 which carries
# 4 unpatched CVEs (CVE-2026-42208 CRITICAL SQL injection,
# CVE-2026-40217 / 42203 / 42271 HIGH arbitrary code / command
# execution). With 3.13 pip resolves to litellm 1.86.2 (CVE-free).
# When upstream litellm publishes a release that lifts the ``<3.14``
# upper bound, bump this back via the Dependabot docker ecosystem.
FROM python:3.13-slim AS runtime

# Cache-bust the apt + pip layers below on every CI run. Without this,
# the GHA buildx cache replays whatever package versions a build from
# weeks ago captured — so even after a debian-security patch lands
# upstream, the layer reused from cache still ships the unpatched
# version and the Trivy gate stays red forever. CI passes
# ``--build-arg CACHEBUST=${{ github.run_id }}`` so each run gets a
# unique value, invalidating this ARG and every subsequent layer.
# Local ``docker build`` without ``--build-arg`` defaults to ``1`` and
# behaves as before (full cache reuse).
ARG CACHEBUST=1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# ``apt-get upgrade -y`` pulls every available debian-security update
# at build time. Without it, the runtime image inherits whatever
# package versions were baked into the upstream ``python:3.13-slim``
# at its last rebuild — typically weeks behind debian-security. As of
# 2026-05 that's 11 HIGH/CRITICAL CVEs in the base (libgnutls30t64
# CVE-2026-33845/42010 CRITICAL, libk5* / libcap2 / libnghttp2-14
# HIGH) that all have ``+deb13uN`` fixes available, but only if the
# build actually fetches them. The Trivy gate in ``docker.yml``
# rejects the push otherwise — this RUN keeps the gate green without
# waiting on a Docker Inc. rebuild of the slim image.
#
# ``echo "$CACHEBUST"`` is load-bearing: BuildKit only treats an
# ``ARG`` as part of a downstream RUN's cache key if that RUN
# *references* the variable. A bare ``ARG CACHEBUST=1`` declaration
# above doesn't invalidate this layer on its own; the cache key
# depends on the RUN text and any referenced vars. So we echo the
# bust value into the command itself — that makes ``CACHEBUST=<run id>``
# from the workflow actually force this layer to rebuild every CI run,
# which is the whole point.
RUN echo "cache-bust: $CACHEBUST" \
 && apt-get update \
 && apt-get upgrade -y \
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
