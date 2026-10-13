# Сайт «Базис» + CRM в Docker. Запуск: docker compose up -d --build (настройки — в .env, см. docker-compose.yml).
# База — PostgreSQL (сервис postgres в docker-compose.yml). Node 22.13+ нужен для разового переноса из старой базы
# SQLite (встроенный node:sqlite); тесты при сборке идут на PGlite (PostgreSQL в WebAssembly) без отдельного сервера.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Тесты — до сборки: с ошибкой в коде образ не соберётся и работающий сайт не будет заменён.
# Манифест картинок (src/generated) не копируется в образ, а тесты витрины его импортируют.
RUN npm run images && npm test
# Адрес сайта зашивается в сборку (canonical, ссылки между сайтами) — передаётся из .env через docker-compose.yml.
ARG SITE_DOMAIN=""
ARG SITE_URL=""
ARG MEDIA_SITE_URL=""
# Без MEDIA_SITE_ENABLED=true ссылок на медиасайт в сборке нет (сервер его тоже не отдаёт).
ARG MEDIA_SITE_ENABLED=""
RUN npm run build

FROM node:22-bookworm-slim
# TZ — даты в именах журналов и резервных копий по местному времени (в контейнере по умолчанию UTC).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    TRUST_PROXY=private \
    TZ=Asia/Almaty
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY ai ./ai
COPY antispam ./antispam
COPY auth ./auth
COPY config ./config
COPY db ./db
COPY documents ./documents
COPY logging ./logging
COPY notify ./notify
COPY runtime ./runtime
COPY security ./security
COPY shared ./shared
COPY public ./public
# Обслуживание базы в контейнере: docker compose exec bazis node scripts/db.js counts | dump | restore.
COPY scripts/db.js ./scripts/db.js
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-media ./dist-media
COPY --from=build /app/images ./images
# Папки томов создаются заранее: новый том берёт из образа владельца node, и сервер может в них писать.
RUN mkdir -p data logs images/uploads && chown -R node:node data logs images/uploads
USER node
EXPOSE 8787
# /api/health отвечает 200, только если PostgreSQL отвечает на SELECT 1. unhealthy Docker сам не лечит —
# контейнер перезапускает watchdog (scripts/docker-autostart.ps1 watch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
