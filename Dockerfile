FROM node:22-bookworm-slim AS deps
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS realtime
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
COPY --from=deps /app/node_modules ./node_modules
COPY realtime-asr-server.mjs ./
USER node
EXPOSE 3001
CMD ["node", "realtime-asr-server.mjs"]

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Shanghai
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
RUN mkdir -p /app/data/question-voices /app/data/app-logs && chown -R nextjs:nodejs /app/data
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
