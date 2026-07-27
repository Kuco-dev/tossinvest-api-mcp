# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────
# tossinvest-api-mcp — MCP stdio 서버
#
# stdio transport 서버이므로 컨테이너의 stdin/stdout 이 MCP 채널이다.
# 반드시 `docker run -i` (또는 compose 의 stdin_open) 로 실행해야 한다.
# stdout 은 JSON-RPC 전용이며 모든 로그는 stderr 로 나간다.
# ─────────────────────────────────────────────────────────────

ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=11.17.0

# ---------- 0. base: pnpm 버전 고정 ----------
# corepack 대신 npm 으로 설치한다. corepack 은 일부 pnpm 릴리스에서
# 서명 검증에 실패하는 사례가 있어 빌드 재현성이 떨어진다.
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# ---------- 1. deps: 전체 의존성 설치 (빌드용) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ---------- 2. build: 컴파일 + 자산 복사 ----------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

# openapi.snapshot.json 을 dist 로 복사하는 단계까지 포함된다.
# 이 파일이 없으면 원격 명세를 못 받을 때 폴백이 불가능하므로 존재를 강제 확인한다.
RUN pnpm build && test -f dist/openapi/openapi.snapshot.json

# ---------- 3. prod-deps: 런타임 의존성만 ----------
# deps 를 prune 하는 대신 --prod 로 새로 설치해 devDependencies 흔적을 남기지 않는다.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod

# ---------- 4. runtime: 최소 실행 이미지 ----------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# 신호(SIGINT/SIGTERM) 전달과 좀비 프로세스 방지를 위해 init 사용
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    TOSSINVEST_LOG_LEVEL=info \
    TOSSINVEST_ENABLE_TRADING=false \
    TOSSINVEST_ENABLE_CONDITIONAL_ORDERS=false \
    TOSSINVEST_ENABLE_RAW_REQUESTS=false \
    TOSSINVEST_ALLOW_CUSTOM_BASE_URL=false

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

# 최소 권한 원칙: root 로 실행하지 않는다.
USER node

LABEL org.opencontainers.image.title="tossinvest-api-mcp" \
      org.opencontainers.image.description="토스증권 Open API MCP (stdio) 서버 — 비공식" \
      org.opencontainers.image.licenses="MIT"

# tini 가 PID 1 을 맡아 SIGTERM 을 Node 로 전달한다 (graceful shutdown).
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
