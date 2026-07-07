# Supabase Backend API

A production-ready Express.js backend for the School Management System, integrated with Supabase and PostgreSql.

## 🚀 Features

- **Supabase Integration**: Auth and Database management using `@supabase/supabase-js`.
- **Postgres Performance**: High-performance database queries using the `postgres` library with tagged template literals.
- **Security**: 
    - Row Level Security (RLS) enabled on all core tables.
    - Security-hardened functions with explicit `search_path`.
    - Helmet, CORS, and Rate Limiting middleware.
- **Audit Pipeline**: Automated schema audit and synchronization tools.

## 📁 Directory Structure

- `server.js`: API entry point.
- `db.js`: Shared database and Supabase client configuration.
- `routes/`: Express route handlers.
- `services/`: Business logic and external service integrations.
- `middleware/`: Custom middleware (Auth, Audit, Error Handling).
- `config/`: Environment-based configuration.
- `audit_tooling/`: Scripts for database schema introspection and synchronization.
- `schema.sql`: Source of truth for the database schema.

## 🛠️ Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```

3. **Run in Development**:
   ```bash
   npm run dev
   ```

## 🧱 Production baseline (recommended)

- **Run behind a process manager**: Docker / Kubernetes / systemd / PM2 (so crashes restart automatically).
- **Set explicit CORS allowlist**: configure `ALLOWED_ORIGINS` in production (avoid `*`).
- **Logging**: structured JSON logs are enabled by default; tune with `LOG_LEVEL`.
- **Graceful shutdown**: handles `SIGTERM`/`SIGINT` and closes DB connections.

### Docker

Build and run:

```bash
docker compose up --build
```

### Important env vars

- **Core**: `PORT`, `NODE_ENV`, `DATABASE_URL`
- **Supabase**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **CORS**: `ALLOWED_ORIGINS` (comma-separated; in prod prefer explicit origins)
- **Runtime**: `LOG_LEVEL` (default `info` in prod), `BODY_LIMIT` (default `1mb`)

### Optional integrations

- **Firebase Admin**: If you need push notifications, set *all three*:
  - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
  If not set, Firebase initialization stays disabled.

## 🔍 Database Audit Pipeline

The project includes a robust pipeline to ensure the live database matches the `schema.sql`.

- **Audit Schema**: Compare live DB against `schema.sql`.
  ```bash
  npm run audit
  ```
- **Sync Schema**: Update `schema.sql` to match the live DB state (idempotent).
  ```bash
  npm run audit:sync
  ```
- **Verify Connection**:
  ```bash
  npm run db:verify
  ```

## 🔒 Security Notes

- All tables must have RLS enabled.
- Functions MUST set `search_path = public` to prevent injection via `search_path`.
- Sensitive variables (like `SUPABASE_SERVICE_ROLE_KEY`) must never be committed to version control.
