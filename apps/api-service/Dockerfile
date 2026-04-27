# syntax=docker/dockerfile:1
# Build context: monorepo root
# docker build -f apps/api-service/Dockerfile -t vantage/api-service:local .

FROM node:22-alpine AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/types/package.json ./packages/types/
COPY apps/alert-engine/package.json ./apps/alert-engine/
COPY apps/api-service/package.json ./apps/api-service/
COPY apps/event-store-service/package.json ./apps/event-store-service/
COPY apps/ingestion-service/package.json ./apps/ingestion-service/
COPY apps/telemetry-simulator/package.json ./apps/telemetry-simulator/
COPY apps/dashboard/package.json ./apps/dashboard/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY packages/types/ ./packages/types/
COPY apps/api-service/ ./apps/api-service/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

RUN pnpm --filter @vantage/api-service deploy --prod --legacy /deploy

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /deploy .

EXPOSE 3004

CMD ["node_modules/.bin/tsx", "src/index.ts"]
