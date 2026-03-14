# ── Build stage ──────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci

# Copy source & build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built output + config from builder
COPY --from=builder /app/dist ./dist

# Dashboard port
EXPOSE 3001

# Health check — dashboard responds on /api/state
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/state').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
