FROM node:22-alpine
COPY --from=ghcr.io/astral-sh/uv:0.6 /uv /bin/
RUN apk add --no-cache curl jq git bash python3 ripgrep
WORKDIR /app
COPY --chown=node package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY --chown=node . .
USER node
VOLUME ["/app/data", "/app/skills", "/app/scripts"]
CMD ["node", "src/index.ts"]
