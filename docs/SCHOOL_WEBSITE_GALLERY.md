# School website gallery architecture

SchoolIMS is the single source of truth for public website gallery content.
The design is tenant-safe and reusable for every school landing page.

## Data flow

1. An admin opens **Website Gallery** in the SchoolIMS admin portal.
2. The app sends an authenticated multipart upload to
   `POST /api/v1/admin/website-gallery`.
3. The backend ignores any client-selected tenant for admin endpoints and uses
   the verified JWT's `schoolId`.
4. The backend validates and re-encodes the image, stores it at
   `<school_id>/gallery/<image_id>.jpg`, and writes a school-scoped database row.
5. A landing page reads
   `GET /api/v1/public/website-gallery?school_id=<configured-school-id>`.
6. Deletion uses `DELETE /api/v1/admin/website-gallery/:id` and includes
   `school_id` in the database predicate, preventing cross-school deletion.

## Reusing the integration

Each school website needs only two environment values:

```bash
SCHOOL_ID=17
SCHOOLIMS_API_URL=https://api.example.com/api/v1
```

The public endpoint is intentionally read-only. Add/delete authority always
comes from the SchoolIMS admin JWT, never from the website's `SCHOOL_ID`.

## Deployment order

1. Run `node scripts/run_all_migrations.js` to apply
   `migrations/20260804_school_website_gallery.sql`.
2. Deploy the SchoolIMS backend.
3. Deploy the SchoolIMS frontend.
4. Configure and deploy each school website.

School 17's five existing GHS Maddur images are seeded as manageable rows by
the migration. Newly uploaded files use the shared public school website bucket.
