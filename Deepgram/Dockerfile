FROM node:22-bookworm

# ── Build OpenClaw from source ──

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# ── Add Deepgram handler ──

# Install Python and uv
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv gettext-base \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install Twilio proxy dependencies
ENV UV_PYTHON_INSTALL_DIR=/opt/python
WORKDIR /twilio-proxy
COPY Deepgram/deepgram_handler/pyproject.toml Deepgram/deepgram_handler/uv.lock* ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy Twilio app code and finish install
COPY Deepgram/deepgram_handler/ .
RUN uv sync --frozen --no-dev

# Fix ownership so node user can run the app
RUN chown -R node:node /twilio-proxy

# Make openclaw CLI available on PATH for the agent
RUN ln -s /app/openclaw.mjs /usr/local/bin/openclaw && chmod +x /app/openclaw.mjs

# Seed data for OpenClaw home volume
COPY Deepgram/home/ /seed-data/

# Entrypoint
COPY --chmod=755 Deepgram/entrypoint.sh /entrypoint.sh

WORKDIR /
USER node
ENTRYPOINT ["/entrypoint.sh"]
