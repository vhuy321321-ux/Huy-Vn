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
