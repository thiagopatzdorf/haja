# Haja no cluster k3s (sistema de apps/sistemas, imagem publicada pelo cd-imagens-k3s.yml).
# Mesma base Node por digest do genesis-radar (uma base Node só para atualizar na casa).
# Duas etapas: a primeira instala tudo e gera o bundle do navegador (esbuild é só de build);
# a segunda leva só as dependências de produção e o bundle pronto. Processo sem root (uid 10001,
# o mesmo do manifest) e raiz só leitura: o banco vive em /data (volume), nada mais é escrito.
#
#   docker build -t haja apps/sistemas/haja
#   docker run --rm -p 8080:8080 -v haja:/data -e HAJA_DB=/data/haja.db --read-only haja
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY lib ./lib
COPY web ./web
RUN npm run build

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 HAJA_DB=/data/haja.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY lib ./lib
COPY relay ./relay
COPY mcp ./mcp
COPY web ./web
COPY --from=build /app/web/vendor ./web/vendor
COPY sistema.json LICENSE README.md ./
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "relay/relay.mjs"]
