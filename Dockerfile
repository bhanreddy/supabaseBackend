# ==========================================
# Build command: docker build -t supabase-backend:latest .
# Run command: docker run -p 3000:3000 --env-file .env supabase-backend:latest
# Expected ARGs: None by default
#
# Stage 1 (builder): Installs production dependencies and prepares the node_modules
# Stage 2 (runner): Copies only what's needed to run the app as a non-root user
# ==========================================

# Stage 1: builder
# WHY slim instead of alpine: The project depends on bcrypt, which often requires
# python and build-essential to compile from source on Alpine's musl libc. 
# Debian-slim provides glibc, allowing it to use pre-built binaries instantly.
FROM node:20.18.0-slim AS builder
WORKDIR /app

# Layer Caching 1: Copy manifest files FIRST
COPY package.json package-lock.json ./

# Layer Caching 2: RUN install BEFORE copying source code
# Reproducibility: Use `npm ci` to lock versions based on package-lock.json
RUN npm ci --omit=dev

# Stage 2: runner
FROM node:20.18.0-slim AS runner
WORKDIR /app

# Non-root user: Create dedicated appuser and group
# Also set correct file ownership in the same RUN layer
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Environment Variables: Safe defaults only, no hardcoded secrets
ENV NODE_ENV=production

# Copy only what is strictly necessary from the builder stage
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
# Copy source code LAST to optimize caching
COPY --chown=appuser:appuser . .

# Healthcheck: using Node's native HTTP module to avoid installing curl/wget (Minimal Attack Surface)
# We append ?school_id=healthcheck because the global middleware requires a school_id
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/api/v1/health?school_id=healthcheck', (r) => { if (r.statusCode !== 200) process.exit(1); process.exit(0); }).on('error', () => process.exit(1));"

# Expose port (metadata)
EXPOSE 8080

# Signal Handling: exec form for graceful shutdowns
CMD ["node", "server.js"]
