FROM node:24-alpine AS build

WORKDIR /app/web

RUN corepack enable pnpm \
    && corepack prepare pnpm@11.21.0 --activate

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY web ./
RUN pnpm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime

ARG APP_SHA=unknown
LABEL org.opencontainers.image.revision="$APP_SHA"

COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz || exit 1

