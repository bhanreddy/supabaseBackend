# Librarian role and library

The `librarian` login opens `/library/dashboard`. Create a staff account in Add Staff and choose **Librarian** under Contact & Login; choosing the Librarian designation also selects this login role. Existing accounts are not automatically reassigned by this migration.

## Install

Deploy the backend and frontend changes together. Run against the intended school database using its existing direct/session connection configuration:

```sh
npm run migrate:release -- --library
```

The migration is also included in the standard `--init` and `--upgrade` release paths. It seeds the role and permissions for existing and future schools and creates library storage. Existing QR storage and the server login QR key must already be configured for the QR tools. No production database migration or deployment is performed by the local tests.

## Features

- Catalog titles with author, ISBN, category, and publisher. Accession physical copies, track shelves, update lost/damaged/withdrawn stock, and archive unused titles while retaining history.
- Issue to active students or school staff, return books with a condition, and renew eligible loans. A transaction-level school lock prevents double lending and races around borrower limits and reservations.
- Queue title reservations, fulfill them in order, and close unneeded holds.
- Configure loan days, maximum loans, renewal limits, and overdue fine per day. Dates use the school timezone; the fine rate is captured when the book is issued. Record full or partial payments against returned-book fines in the library ledger, with an audit trail. These payments are not school-fee receipts or a payment gateway integration.
- View inventory and circulation totals, overdue loans, loan history, fine balances, and recent activity. Export the summary/activity report as CSV.
- Use the existing staff complaint wizard to report on any active student in the school, individually or in a batch. Librarians see their own reports; administrators handle resolutions through the existing complaint flow. Teachers retain their existing class-assignment checks. Parent/student notifications retain their current behavior.
- Generate, regenerate, preview, print, and export Student Login QR and Role Login QR cards using the existing tools. Librarians may issue role cards for librarian, staff/teacher, driver, gatekeeper, and parent accounts. Accounts, principal, management, and admin accounts outrank librarians and remain unavailable to them. Student login setup is referred to Accounts/admin.

Administrators and principals can open Library from the admin navigation. Librarians receive library and complaint permissions only; they do not receive school administration, staff management, or fee permissions.

## Verify

```sh
node --experimental-test-module-mocks --test utils/libraryRules.test.js utils/roleLoginQr.test.js utils/studentLoginQr.test.js tests/schoolId.test.js tests/crossTenantSecurity.test.js
```

For the PostgreSQL API integration suite, create a disposable **local** database named `library_test` (or beginning with `library_test_`) and supply its URL explicitly. The suite recreates its public schema; it rejects remote URLs and does not use `DATABASE_URL`.

```sh
LIBRARY_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/library_test node --experimental-test-module-mocks --test tests/library.integration.test.js
```

Frontend checks, run in SchoolIMS-Frontend:

```sh
npm run typecheck
npx jest --runInBand src/features/library/LibraryWorkspace.test.tsx src/utils/librarianRole.test.ts src/__tests__/qrLogin.test.tsx
npx expo export --platform web
```
