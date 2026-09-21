# Staging capacity baselines

The attendance baseline performs real attendance writes and therefore refuses a
base URL that does not look like staging, test, or localhost. It uses 20 teacher
fixtures, ramps to 25 iterations per second (one roster request and one submit
request per iteration), and targets the program's 50 requests/second peak for
10 minutes.

Run it only with dedicated staging teachers and classes:

```sh
export API_BASE_URL='https://schoolims-staging.example.com'
export ATTENDANCE_FIXTURES_JSON='[{"token":"REDACTED","date":"2026-09-21","session":"morning"}]'
k6 run --summary-export=attendance-baseline.json tests/load/k6_teacher_attendance.js
```

`ATTENDANCE_FIXTURES_JSON` must contain at least 20 entries. Tokens are read
from the environment and never written by the script. Alongside the k6 summary,
capture Cloud Run request/instance metrics and PostgreSQL `pg_stat_activity` so
the p95, 5xx, and active-connection success criteria can be evaluated together.
