# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Smoke test for tiktoken WASM under Alpine musl
RUN node -e "require('tiktoken').get_encoding('cl100k_base')"

# Production stage
FROM node:20-alpine
WORKDIR /app

# Add non-root user
# Note: node:20-alpine already includes a 'node' user, so we can just use that
# but to be safe and explicit, we'll use it
RUN mkdir -p /home/node/.relay && chown -R node:node /home/node/.relay /app

COPY package*.json ./
# Install production dependencies only
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV RELAY_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${RELAY_PORT}/health || exit 1

CMD ["node", "dist/index.js"]
