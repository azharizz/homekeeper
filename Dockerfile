FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --workspaces=false --no-audit --no-fund
COPY index.html vite.config.js ./
COPY web ./web
RUN npx vite build
RUN npm prune --workspaces=false --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY capability ./capability
COPY alexa_host ./alexa_host
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "alexa_host/server.js"]
