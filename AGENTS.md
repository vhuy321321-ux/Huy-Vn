# Repository development guide

## Git and pull request workflow

- Start each independent task on its own branch, based on the latest relevant base branch. Do not reuse a task branch for unrelated work.
- Before editing, inspect `git status`, the current branch, remotes, and the latest commit. Preserve existing user changes and history.
- Run the checks relevant to the change before committing. If a check fails, inspect the failure, fix issues that can be corrected safely, and rerun the affected checks.
- Keep commits focused and use clear messages. After a verified commit, record its commit hash as the task checkpoint.
- Push the task branch to `origin` without force-pushing, then create or update a pull request targeting `main`. Never merge a pull request unless explicitly requested.
- If GitHub authentication or network access is unavailable, finish and document the local work and report the exact access step needed. Never ask for tokens in chat or store credentials in the repository.

## Android build

- The Android project currently lives in `GoalFlow-Android-WebView-MVP.zip`.
- Pull requests targeting `main` run `.github/workflows/build-apk.yml` on GitHub-hosted Ubuntu with Java 17 and Gradle 8.9.
- The workflow builds the debug APK and uploads it as the `GoalFlow-APK` artifact. Prefer this hosted build when Android/Gradle tooling is unavailable locally.

## Notion sync changes

- The Android app source is stored in `GoalFlow-Android-WebView-MVP.zip`. The Worker-hosted browser UI is mirrored at `worker/public/index.html`; keep it byte-for-byte identical to the ZIP asset and verify it with `node --test worker/test/index.test.mjs`.
- Android files mirrored under `worker/android-src/` are source inputs for the corresponding ZIP entries. Keep those files and archive entries identical.
- After editing mirrored Android files, update the ZIP with `powershell -ExecutionPolicy Bypass -File worker/scripts/Update-AndroidZip.ps1`; it checks and preserves the other archive entries.
- Keep the Notion integration token, login password, and session-signing key in Cloudflare Worker Secrets only. Never add credentials to the app, browser storage, workflow, repository, tests, or logs.
- Run the Worker mock suite with `node --test worker/test/index.test.mjs`; it must not require live Notion or Cloudflare credentials. Do not deploy or change a Cloudflare billing plan without explicit authorization.
- Notion sync is manual and non-destructive: preserve stable GoalFlow IDs, report conflicts, and never infer deletion from missing, failed, or incomplete Notion reads.
