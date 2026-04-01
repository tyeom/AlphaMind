FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY libs/common/package.json ./libs/common/package.json
COPY libs/strategies/package.json ./libs/strategies/package.json
RUN pnpm install --frozen-lockfile --filter @alpha-mind/backend...

# Build
FROM base AS build
COPY --from=deps /app ./
COPY apps/backend ./apps/backend
COPY libs/common ./libs/common
COPY libs/strategies ./libs/strategies
RUN pnpm --filter @alpha-mind/common run build
RUN pnpm --filter @alpha-mind/strategies run build
RUN pnpm --filter @alpha-mind/backend run build

# Production
FROM base AS production
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY libs/common/package.json ./libs/common/package.json
COPY libs/strategies/package.json ./libs/strategies/package.json
RUN pnpm install --frozen-lockfile --filter @alpha-mind/backend...
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/libs/common/dist ./libs/common/dist
COPY --from=build /app/libs/strategies/dist ./libs/strategies/dist

WORKDIR /app/apps/backend
EXPOSE 3000
CMD ["sh", "-c", "node -e \"const c = require('./dist/config/mikro-orm.config').default; const { MikroORM } = require('@mikro-orm/core'); MikroORM.init(c).then(orm => orm.getMigrator().up().then(() => orm.close()))\" && node dist/main.js"]
