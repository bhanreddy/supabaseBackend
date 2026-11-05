# Tracking and map improvements — 3 November 2026

Follow-up: [GPS precision update](gps-precision.md) changes capture cadence, filtering, freshness, and migration requirements described below.

The parent and admin views now share a real MapLibre street map on native and web. The existing web placeholder is replaced by a bundled `maplibre-gl` adapter; OpenStreetMap raster tiles supply the basemap. Route lines connect consecutive, valid stop coordinates in execution order, with completed sections muted. Missing coordinates break a line rather than inventing geometry. Lines are stop connections, not road routing.

The map opens with the whole route visible, supports following the bus, stops following during manual panning, and can fit the route again. Numbered stops, the parent's boarding stop, selected-stop focus, last-known-position styling, and clickable map attribution improve orientation. Web bus markers interpolate between received coordinates. Parent street maps use observed fixes; a route simulation explicitly opens the schematic diagram. Scheduled maps do not invent a bus position.

The admin workspace includes searchable routes, an active-trip filter, fleet counts, trip progress, the next stop, a selectable stop timeline, driver connectivity, and notification delivery health. At phone width, a compact expandable route selector keeps the map closer to the top. Failed route requests preserve the directory; a late response from another selection cannot replace the current route. GPS and driver connection ages continue to increase locally during network interruption.

ETA uses the learned duration of the unfinished segment when the bus is near that segment's geographic corridor. Off-route observations fall back to bounded speed estimates. Missing/implausible speeds, poor accuracy, stale/future timestamps, and mocked/suspicious observations cannot produce an unwarranted confident ETA. Confirmed intermediate arrivals add no fictitious approach leg; only a confirmed boarding-stop arrival produces a zero-minute point estimate. Both map feeds include the GPS quality flags used for eligibility.

## Verification

Run `npm run test:transport` in SchoolIMS-Backend. The verifier creates and removes a synthetic local PostgreSQL cluster and includes the new ETA, parent, admin, geometry, and map-control regression tests. Latest result: **82 tests passed** (26 backend unit, 19 SQL/HTTP integration, 29 frontend Jest, 8 frontend Node), plus native location configuration checks. Reports are in `verification/`.

Frontend TypeScript checking, focused ESLint, and Expo web export also pass. A local fixture preview was inspected at desktop and 390px widths, including switching between active and scheduled routes. Preview icons/header/API responses were substituted to isolate the actual screen and shared map; screenshots are illustrative synthetic journeys.

No database migration is required. No backend deployment, native binary release, production journey, or physical-device acceptance was performed. Map tiles require network access; actual road geometry and traffic-provider routing remain outside this change.
