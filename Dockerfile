FROM node:22-alpine
COPY --from=ghcr.io/astral-sh/uv:0.6 /uv /bin/
RUN ln -s /bin/uv /bin/uvx
RUN apk add --no-cache curl jq git bash python3 ripgrep \
    chromium nss freetype harfbuzz font-noto-cjk font-noto-emoji
RUN npm install -g agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV AGENT_BROWSER_HEADLESS=1
WORKDIR /app
COPY --chown=node package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY --chown=node . .
USER node
VOLUME ["/app/data", "/app/skills", "/app/scripts"]
CMD ["node", "src/index.ts"]
