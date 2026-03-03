FROM node:22-alpine
RUN apk add --no-cache curl jq git bash python3
RUN adduser -D assistant
WORKDIR /app
COPY --chown=assistant package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY --chown=assistant . .
USER assistant
VOLUME ["/app/data", "/app/skills", "/app/tools"]
CMD ["node", "src/index.ts"]
