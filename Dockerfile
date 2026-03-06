FROM node:22-slim
COPY --from=ghcr.io/astral-sh/uv:0.6 /uv /bin/
RUN ln -s /bin/uv /bin/uvx
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq git bash python3 ripgrep \
    chromium fonts-noto-cjk fonts-noto-color-emoji \
    libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_HEADLESS=1
WORKDIR /app
COPY --chown=node package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY --chown=node . .
USER node
VOLUME ["/app/data", "/app/skills", "/app/scripts"]
CMD ["node", "src/index.ts"]
