# NexSyrus subdomain CORS proxy

Catalyst rejected `*.nexsyrus.com` in Authorized Domains on October 14, 2026.
Its gateway answers OPTIONS before requests reach AppSail, so a wildcard rule in
Express alone cannot resolve browser preflight failures.

This Cloudflare Worker answers preflight requests at `simsapi.nexsyrus.com` and
forwards other requests to the existing AppSail backend. It allows the HTTPS apex
and every HTTPS subdomain, including nested subdomains. It rejects lookalike
suffixes and unrelated domains, preserves application authentication and tenant
headers, and replaces upstream CORS headers to avoid duplicates.

The direct `catalystappsail.in` address continues using Catalyst's explicit
domain whitelist. Frontends should use `https://simsapi.nexsyrus.com/api/v1`.

Validate:

```sh
node --test deploy/cors-proxy/worker.test.mjs
npx wrangler@4 deploy --config deploy/cors-proxy/wrangler.jsonc --dry-run
```

Deploy after signing in to the Cloudflare account that owns `nexsyrus.com`:

```sh
npx wrangler@4 login
npx wrangler@4 deploy --config deploy/cors-proxy/wrangler.jsonc
```

Before deploying, inspect existing Workers and routes for `simsapi.nexsyrus.com/*`.
If a Worker already owns that route, preserve its existing behavior and integrate
this CORS handling there rather than replacing it blindly.

Deployed to the existing `simsapi` Worker through the Cloudflare dashboard on
October 14, 2026. Active version: `f1257c32`. The original upstream, timeout,
forwarded client information and authentication behavior were preserved. A local
backup of the previous source is in the ignored `.catalyst/verification/` folder.

Live verification passed for new and nested NexSyrus origins: OPTIONS returned
204 and API GET returned 200 with a single reflected origin and credentials
header. Lookalike domains were rejected, and readiness confirmed the AppSail
database and scheduled workers were healthy. The full check results are saved in
`.catalyst/verification/wildcard-cors-results.json`.
