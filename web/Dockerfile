# ── 构建阶段 ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ── 运行阶段：nginx 同时托管静态资源与反代 /api → api:8000 ───────────────
FROM nginx:1.27-bookworm

# nginx 基础镜像不含 wget/curl，装一个供 HEALTHCHECK 使用
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=5s --timeout=3s --start-period=8s --retries=10 \
    CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
