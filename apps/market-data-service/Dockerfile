FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/market-data-service/package.json ./apps/market-data-service/package.json
COPY libs/common/package.json ./libs/common/package.json
COPY libs/strategies/package.json ./libs/strategies/package.json
RUN pnpm install --frozen-lockfile --filter @alpha-mind/market-data-service...

# Build
FROM base AS build
COPY --from=deps /app ./
COPY apps/market-data-service ./apps/market-data-service
COPY libs/common ./libs/common
COPY libs/strategies ./libs/strategies
RUN pnpm --filter @alpha-mind/common run build
RUN pnpm --filter @alpha-mind/strategies run build
RUN pnpm --filter @alpha-mind/market-data-service run build

# Production
FROM base AS production
WORKDIR /app

# Claude Code CLI + Codex CLI 설치
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
    && mkdir -p /root/.claude /root/.codex

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/market-data-service/package.json ./apps/market-data-service/package.json
COPY libs/common/package.json ./libs/common/package.json
COPY libs/strategies/package.json ./libs/strategies/package.json
RUN pnpm install --frozen-lockfile --filter @alpha-mind/market-data-service...
COPY --from=build /app/apps/market-data-service/dist ./apps/market-data-service/dist
COPY --from=build /app/libs/common/dist ./libs/common/dist
COPY --from=build /app/libs/strategies/dist ./libs/strategies/dist
COPY apps/market-data-service/data ./apps/market-data-service/data

# .agents 디렉토리 (볼륨 마운트 대상)
RUN mkdir -p /app/.agents

WORKDIR /app/apps/market-data-service

ENV CLAUDE_CLI_PATH=/usr/local/bin/claude
ENV CODEX_CLI_PATH=/usr/local/bin/codex
ENV AGENTS_CONFIG_DIR=/app/.agents
ENV CLAUDE_CONFIG_DIR=/root/.claude
ENV CODEX_HOME=/root/.codex
# 전 종목 스캔(scanAllStocks) 같은 워킹셋이 큰 작업의 OOM 방지용 heap 상한.
ENV NODE_OPTIONS=--max-old-space-size=3072

EXPOSE 3001
CMD ["sh", "-c", "node -e \"const c = require('./dist/config/mikro-orm.config').default; const { MikroORM } = require('@mikro-orm/core'); MikroORM.init(c).then(orm => orm.getMigrator().up().then(() => orm.close()))\" && node dist/main.js"]
