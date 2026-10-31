# SchoolIMS on Catalyst AppSail

The `simsapi` service deploys the complete Express API to the `Simsbackend`
Catalyst project (`85891000000013050`) in the India region. The regular Catalyst
CLI deployment targets the Development environment.

Deployed endpoint: https://simsapi-50046891665.development.catalystappsail.in

On October 14, 2026, the deployed ping, liveness and readiness checks returned
HTTP 200. Readiness confirmed database connectivity and scheduled job readiness.
The focused authentication, school context and role QR checks passed (34 tests).
The full existing suite reported 777 passing, 11 failing and one skipped test;
failures were in event operations, feature access and transport safety tests.
Deployment does not resolve those application test failures.

Run from the backend directory:

```sh
npm run deploy:catalyst
```

The deployment script reads `.env`, stages the application in `.catalyst/build`,
installs locked production dependencies for Linux x64, and generates a private
`app-config.json`. It uploads environment variables through Catalyst's server
configuration, separately from the application archive. Both generated paths
are ignored by Git. Credentials are never printed. Use
`CATALYST_ENV_FILE=/absolute/path/to/server.env npm run deploy:catalyst` to select
another environment file.

The runtime is Node.js 24 with 1024 MB memory. `NODE_ENV` is set to `production`
for secure runtime defaults even in Catalyst's Development environment. The API
listens on `X_ZOHO_CATALYST_LISTEN_PORT`; local `PORT` remains supported elsewhere.
The database, authentication, storage and Firebase integrations continue using
the configured Supabase and Firebase services.

Browser access requires each frontend hostname in Catalyst Authentication's
Authorized Domains list with CORS enabled. The deployment script sets
`PLATFORM_MANAGED_CORS=true`, so Catalyst supplies origin and credentials headers
for both preflight and API responses. Express keeps only the exposed API metadata
headers in this mode, preventing duplicate origin headers rejected by browsers.
Local and other deployments keep Express CORS by default.

Catalyst rejected the wildcard domain `*.nexsyrus.com` when it was submitted to
Authorized Domains. All HTTPS NexSyrus subdomains are supported through the
existing Cloudflare `simsapi` Worker at `https://simsapi.nexsyrus.com/api/v1`.
Its source is in `deploy/cors-proxy/`; its seven tests and Wrangler build passed.
The update was deployed through Cloudflare's dashboard on October 14, 2026
(active version `f1257c32`). Live checks passed for the apex, new subdomains and
nested subdomains, with OPTIONS returning 204 and API GET returning 200. Lookalike
domains were rejected. AppSail database and scheduled worker readiness remained
healthy. The direct Catalyst address still uses its explicit whitelist.

Verification endpoints:

- `/api/v1/ping`: HTTP connectivity.
- `/api/v1/healthz`: process liveness.
- `/api/v1/readyz`: database connectivity and scheduled worker readiness.

PaperForge needs an externally reachable `PAPERFORGE_ENGINE_URL`. The script
omits localhost addresses, which disables that optional integration remotely.
Other optional features still require their corresponding environment variables.

AppSail scales instances according to traffic. In-process timers and scheduled
workers require a running instance; evaluate an always-running instance or
Catalyst Job Scheduling before relying on unattended scheduled tasks.

This deployment does not change the frontend API URL, move the PostgreSQL
database into Catalyst Data Store, or promote the project to Production.
