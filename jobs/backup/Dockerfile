# ====================================================================
# Production Dockerfile for SchoolIMS Database Backup Worker
# Target: GCP Cloud Run Job (schoolims-db-backup)
# Runtime: Node.js 20 + PostgreSQL 17 client utilities (pg_dump, pg_restore)
# ====================================================================

FROM node:20.18.0-bookworm-slim AS base

# Install required system tools & official PostgreSQL 17 client
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Stage 1: Build dependencies
FROM base AS dependencies
COPY package.json ./
RUN npm install --omit=dev

# Stage 2: Final minimal runner
FROM base AS runner
WORKDIR /app

# Create dedicated non-root user and secure scratch directories
RUN groupadd -r backupgroup && useradd -r -g backupgroup -d /app -s /sbin/nologin backupuser \
    && mkdir -p /tmp/schoolims-backups \
    && chown -R backupuser:backupgroup /app /tmp/schoolims-backups \
    && chmod 0700 /tmp/schoolims-backups

# Copy node_modules and application source only (never deploy scripts or secrets)
COPY --from=dependencies --chown=backupuser:backupgroup /app/node_modules ./node_modules
COPY --chown=backupuser:backupgroup package.json ./
COPY --chown=backupuser:backupgroup src ./src

# Run as non-root user
USER backupuser

ENV NODE_ENV=production
ENV LOCAL_BACKUP_DIR=/tmp/schoolims-backups
ENV PG_DUMP_PATH=/usr/lib/postgresql/17/bin/pg_dump
ENV PG_RESTORE_PATH=/usr/lib/postgresql/17/bin/pg_restore

# Entrypoint executes one backup run and exits cleanly
ENTRYPOINT ["node", "src/index.js"]
