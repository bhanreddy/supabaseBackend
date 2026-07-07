# SchoolIMS: school_id Contract

## Absolute Rule — No Exceptions

Every API request (GET, POST, PUT, PATCH, DELETE) from the frontend MUST explicitly include `school_id`. Every backend route MUST receive, validate, and use `school_id` in its query/mutation.

---

## Frontend Rules

- `school_id` is sourced from build-time env: `EXPO_PUBLIC_SCHOOL_ID` (or `process.env.SCHOOL_ID`).
- **GET requests:** pass `school_id` as query parameter → `GET /students?school_id=xyz`
- **POST/PUT/PATCH:** pass `school_id` in request body → `{ school_id: "xyz", ...payload }`
- **DELETE:** pass `school_id` as query parameter → `DELETE /student/123?school_id=xyz`
- Never hardcode `school_id`. Always pull from the env constant.

The central API client (`testapp/src/services/apiClient.ts`) injects `school_id` automatically for all requests.

---

## Backend Rules

- Every route extracts `school_id` from `req.query` (GET/DELETE) or `req.body` (POST/PUT/PATCH).
- Every DB query/mutation MUST include `WHERE school_id = $n` (or equivalent). No query runs without it.
- If `school_id` is missing or empty → reject with `400 Bad Request: school_id is required`.
- Never infer or default `school_id` from auth context, JWT, or session. It must always be explicitly passed.

---

## Response Rules

- Every success response MUST echo `school_id` in the envelope:
  ```json
  { "success": true, "school_id": "xyz", "data": [...] }
  ```
- Error responses may omit `school_id`.

---

## Documented Exceptions

### Routes that do NOT require school_id

| Route prefix | Reason |
|--------------|--------|
| `/api/super-admin/*` | Cross-tenant super-admin operations; has its own auth and does not use school scoping. |

### Routes that DO require school_id (all others)

| Route | school_id source |
|-------|------------------|
| `GET /api/v1/health` | Query: `?school_id=...` |
| `POST /api/v1/auth/login` | Body: `{ school_id, email, password }` |
| `POST /api/v1/auth/refresh` | Body: `{ school_id, refresh_token }` |
| All `/api/v1/*` (students, staff, fees, etc.) | Query for GET/DELETE; body for POST/PUT/PATCH |

---

## Implementation Reference

- **Middleware:** `middleware/schoolId.js` — `getSchoolId(req)`, `requireSchoolId`
- **Response helper:** `utils/apiResponse.js` — `sendSuccess(res, schoolId, data, statusCode?)`
- **Frontend client:** `testapp/src/services/apiClient.ts` — auto-injects `school_id` per method
