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

FROM maven:3.9-eclipse-temurin-17 AS sambert-sdk
WORKDIR /sdk
COPY sambert-sdk/pom.xml sambert-sdk/settings.xml ./
COPY sambert-sdk/src ./src
RUN mvn -B -s settings.xml -DskipTests package

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
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
RUN mkdir -p /app/data/question-voices && chown -R nextjs:nodejs /app/data
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=sambert-sdk --chown=nextjs:nodejs /sdk/target/sambert-tts-bridge-1.0.0-jar-with-dependencies.jar ./bin/sambert-tts-bridge.jar
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
