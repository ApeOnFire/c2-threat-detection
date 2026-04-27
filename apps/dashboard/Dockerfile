# syntax=docker/dockerfile:1
# Build context: monorepo root
# docker build -f apps/dashboard/Dockerfile -t vantage/dashboard:local .

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
COPY apps/dashboard/ ./apps/dashboard/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

WORKDIR /app/apps/dashboard
RUN node_modules/.bin/ng build --configuration=production

FROM nginx:alpine AS runtime
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist/dashboard/browser /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
