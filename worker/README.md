# GoalFlow Notion sync (preview)

This is a manual, single-user sync service. The Android app sends requests through its native HTTPS bridge; the same HTML page is served from the Worker for browser use. Only the Worker calls Notion. No Notion token is included in the ZIP, browser storage, or APK.

## Data model and behavior

Create and share two Notion data sources with the internal connection before configuring the Worker:

| Data source | Property | Type | Mapping |
| --- | --- | --- | --- |
| Goals | Name | Title | Goal title |
| Goals | GoalFlow ID | Rich text | Stable goal ID; do not edit |
| Goals | Deadline | Date | Goal deadline, date only |
| Goals | Progress | Number | Completed leaf tasks / all leaf tasks, rounded to percent |
| Tasks | Name | Title | Task or subtask title |
| Tasks | GoalFlow ID | Rich text | Stable task ID; do not edit |
| Tasks | Due Date | Date | Task deadline, date only |
| Tasks | Status | Select (`Todo`, `Done`) | Existing GoalFlow checkbox maps to Todo or Done |
| Tasks | Goal | Relation to Goals | Goal ownership |
| Tasks | Parent Task | Self relation to Tasks | Empty for top-level task; parent task for a subtask |

Progress counts only leaf tasks. A task with subtasks is a container and is not counted separately. The `Progress` property is derived from GoalFlow and should not be edited manually. Dates use `YYYY-MM-DD`. Only one subtask level is offered in the current app UI. The current app has one goal; Notion records are still keyed by stable IDs for safe imports and future expansion.

The first sync uploads the current local goal and tasks. Use **Export backup** and import it on another device before its first Notion sync so it carries the same GoalFlow IDs. The app does not match by title or silently deduplicate records. Rows without a `GoalFlow ID` are left untouched and ignored by the sync.

Every sync reads all active rows in both configured data sources, following Notion cursors (up to 8 pages of 100 rows per source per request). A sync needing more than eight writes returns `SYNC_WRITE_LIMIT` before writing anything; retry after splitting the edits into smaller groups. The Worker never deletes or archives Notion rows. A row missing from a successful read while present in the previous base is retained locally and is not recreated automatically; restore it manually in Notion if needed. If only GoalFlow or Notion changed since the last successful sync, that side wins. If both changed differently, sync reports a conflict and changes neither side; make the values match in both places (or restore one side to its last synchronized value), then retry.

The app stores only the last successfully synchronized base snapshot and Worker URL in device-local storage. The Worker returns opaque errors and does not log request bodies, passwords, session tokens, or Notion API responses. Notion `429` and safe read-only `5xx` requests are retried up to three times, honoring `Retry-After` when it is at most 10 seconds; longer waits return a safe error for a later manual retry. Page-creation `5xx` requests are not retried because Notion may have accepted the write before returning an error. Repeated edits during sync are detected by a pre-update re-read; Notion does not expose conditional writes, so an edit in the narrow interval after that check remains a documented race. D1 serializes concurrent syncs with a short lease.

## Authentication and secrets

- `NOTION_TOKEN`: secret for the Notion internal connection, stored with `wrangler secret put NOTION_TOKEN` only.
- `GOALFLOW_LOGIN_PASSWORD`: a separate, long random passphrase you choose and enter in the app. Store it with `wrangler secret put GOALFLOW_LOGIN_PASSWORD` only. The Worker applies a D1 per-IP limit (five attempts per 15-minute window) and fails closed if the D1 binding is unavailable.
- `SESSION_SIGNING_SECRET`: a random value with at least 32 bytes of entropy, stored with `wrangler secret put SESSION_SIGNING_SECRET`. Login returns a signed session valid for 15 minutes. Android keeps it only in process memory; browser mode keeps it only in JavaScript memory.
- `WEB_ORIGIN`: exact HTTPS origin serving the Worker-hosted page, including scheme and hostname and no path. It is not a secret. The Android native HTTPS bridge does not rely on CORS.
- `GOALS_DATA_SOURCE_ID` / `TASKS_DATA_SOURCE_ID`: Notion data source IDs. They are configuration, not tokens; keep them in Wrangler variables, not in client code.

The login passphrase is not a fixed bearer key embedded in the app. Do not reuse a Notion password. Never paste these values into chat, commit them, or put them in a `.env` file tracked by Git. The repo contains only example placeholders.

## Free-tier deployment (manual; not performed by CI)

This repository does not deploy automatically. CI runs mock-only tests and builds the APK; it needs no Notion or Cloudflare secrets.

1. In Notion, create an **Internal** connection in the intended personal workspace. Grant read, insert, and update content capabilities. Share the Goals and Tasks data sources with that connection. Create the property schema above and copy both data source IDs.
2. Create a Cloudflare account/Worker on the Free plan. Install Wrangler locally and authenticate with its official interactive browser flow (`npx wrangler login`). Do not provide credentials to this repository or to CI.
3. Create a D1 database on the Free plan. Put its ID in `worker/wrangler.jsonc`. Run `npx wrangler d1 execute goalflow-auth --remote --file=worker/schema.sql` to create the rate-limit and sync-lock tables.
4. Set the three secret values in an interactive terminal, one command at a time: `npx wrangler secret put NOTION_TOKEN`, `npx wrangler secret put GOALFLOW_LOGIN_PASSWORD`, and `npx wrangler secret put SESSION_SIGNING_SECRET`. The values are entered into Wrangler's prompt, never into chat or shell history.
5. Replace the Worker URL/origin and data source placeholders in `worker/wrangler.jsonc`. Deploy manually with `npx wrangler deploy`; the browser UI is served from that Worker URL. Set `WEB_ORIGIN` to that exact URL and deploy the variable change if the assigned `workers.dev` hostname was not known earlier.
6. In GoalFlow, enter the Worker HTTPS URL and the separate login passphrase, then choose **Đăng nhập và đồng bộ**. Sync is user initiated; there are no Cron Triggers or background schedules.

Do not change the account to Workers Paid or enable any paid add-on. Current Cloudflare documentation lists Workers Free at 100,000 requests/day and 10 ms CPU per invocation. D1 Free includes 5 million rows read/day, 100,000 rows written/day, and 5 GB storage; over-limit Free usage fails instead of automatically upgrading. Check your Cloudflare dashboard and account eligibility before deployment because plan availability and limits can change. No hosting account, Worker, or D1 database has been created by this change.

## Local checks

```sh
node --check worker/src/index.mjs
node --test worker/test/index.test.mjs
node tests/web-backup.test.mjs worker/public/index.html
```

The Android HTML, manifest, and Kotlin source are mirrored under `worker/public/` and `worker/android-src/` to make binary ZIP changes reviewable. After changing a mirror, run `powershell -ExecutionPolicy Bypass -File worker/scripts/Update-AndroidZip.ps1`; the script builds and verifies a temporary archive before replacing the ZIP, preserving all other entries. The Worker test checks byte-for-byte parity. Android APK compilation is performed by GitHub Actions on Ubuntu with Java 17 and Gradle 8.9. This test suite mocks Notion and Cloudflare; it does not validate a real workspace, capability grants, live rate limits, Worker deployment, or behavior on a physical Android device.
