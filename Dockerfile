FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM base AS prod-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

FROM base AS builder
COPY --from=build-deps /app/node_modules ./node_modules
COPY . .
RUN yarn build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=4000 \
  DATABASE_PATH=/app/data/mission-control.db \
  WORKSPACE_BASE_PATH=/app/workspace \
  PROJECTS_PATH=/app/workspace/projects

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs

RUN mkdir -p /app/data /app/workspace/projects /app/deliverables \
  && chown -R node:node /app

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/events').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["yarn", "start"]
