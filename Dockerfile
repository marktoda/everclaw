FROM node:22-alpine
RUN apk add --no-cache curl jq git bash python3
WORKDIR /app
COPY --chown=node package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY --chown=node . .
USER node
VOLUME ["/app/data", "/app/skills", "/app/tools"]
CMD ["node", "src/index.ts"]
