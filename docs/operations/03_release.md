# Release Runbook

Desktop and CLI releases come from `.github/workflows/release.yml`. There is no scheduled nightly pipeline; every release is cut by hand from a `vX.Y.Z` tag (a `-suffix` tag is a GitHub prerelease).

## Triggers

- **Dispatch (preferred):** run **Release** with `tag=vX.Y.Z` from the commit to ship. It reuses a release with that tag or creates a draft, builds, uploads every asset, and publishes the draft only when `publish_draft` is set. Without it the draft stays for review. Publishing that draft by hand fires the publish trigger below and rebuilds every asset on the now-public release, so to ship a reviewed draft, dispatch again with `publish_draft` instead (the workflow's own publish does not retrigger it).
- **Publishing a release in GitHub:** builds and attaches assets to the already-published release. A stable release is GitHub's `latest` from the moment it is published, so for the 30+ minutes the build takes, `code.ankiel.com/install.sh` 404s (`curl -fsSL … | sh` prints the error and installs nothing) and the desktop download routes fall back to the release page. Use dispatch with `publish_draft` to avoid that window.

An upload replaces an existing asset of the same name. On a published release that is not atomic: rebuilt archives are attached before the new `SHA256SUMS`, so installs and server updates fail their checksum until the rerun finishes. Rerun drafts freely; rerun a published release only to repair it.

## What a release produces

| Asset                                                                             | Built by          | Read by                                                                        |
| --------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| macOS arm64 `.dmg`/`.zip`, Windows x64 `.exe`, blockmaps, `latest*.yml`           | `package_desktop` | Users, `code.ankiel.com/download/*`, electron-updater                          |
| `ankiel-<version>-{darwin-arm64,linux-x64,linux-arm64}.tar.gz`, `…-win32-x64.zip` | `cli_archive`     | `install.sh`/`install.ps1`, SSH remotes, server self-updates (`cliRelease.ts`) |
| `SHA256SUMS` (CLI archives only)                                                  | `publish_release` | Everything that verifies a CLI archive                                         |
| `SHA256SUMS.txt` (every download)                                                 | `publish_release` | Users, `code.ankiel.com/download/checksums`                                    |
| `ankiel-release.json` (highest server migration)                                  | `publish_release` | Update track switches                                                          |
| `install.sh`, `install.ps1`                                                       | `publish_release` | `code.ankiel.com/install.sh` and `/install.ps1`, which redirect to the latest  |

There is no macOS x64 or Windows arm64 CLI archive. Node single-executables segfault on x64 macOS, and Windows arm64 is not built. The installers, SSH remotes, and server self-updates on those hosts report that the host is not supported.

## Critical release invariants

- **Upload order:** archives and installers first, then `SHA256SUMS`, `SHA256SUMS.txt`, `ankiel-release.json`, and the install scripts, then the updater manifests. Installers and connected servers treat a present `SHA256SUMS` as the release being ready, and desktop clients update connected servers to their own version as soon as they see the manifests.
- **Node pin:** `engines.node` in the root `package.json` must stay exact. Native single-executable builds reject any other Node.
- **Linux arm64** CLI archives build on an arm64 runner (`ubuntu-24.04-arm`); `--build-sea` output from another host cannot load on 16/64 KiB page kernels.
- **WSL runtime:** `scripts/build-desktop-artifact.ts` can embed a Linux CLI archive in the Windows app as `resources/wsl-runtime.tar.gz` (`--wsl-runtime` / `ANKIEL_DESKTOP_WSL_RUNTIME`), but `release.yml` does not pass one today.
- **Smoke fixture:** `scripts/fixtures/desktop-launch` is intentionally an old SQLite snapshot to verify forward migrations on packaged builds. Never regenerate it on schema changes.

Signing is optional everywhere: a job builds unsigned (macOS CLI archives ad hoc) when its secrets are missing.

## Mobile releases

- **iOS TestFlight / App Store:** Merges to `main` publish compatible OTAs and build TestFlight prereleases (`testflight` profile at `3.0.0`). To cut an App Store build, dispatch **Mobile EAS Production** (`mode=build`, `profile=production`, `platform=ios`, explicit version). Before shipping `3.0.0` to the App Store, advance `build.testflight.env.ANKIEL_MOBILE_VERSION` in `apps/mobile/eas.json` to the next unreleased major.
- **Android APK mirror:** `.github/workflows/mobile-android-apk.yml` polls Google Play Alpha hourly and mirrors new Play-signed universal APKs to `android-beta-<build-number>` prereleases (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`).

## One-time credentials setup

### Apple signing and notarization (macOS)

- **Secrets:** `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (raw `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE` (base64 profile for `com.ankiel.ankielcode`).
- **Variables:** `ANKIEL_APPLE_TEAM_ID`.
- The desktop packager only enables entitlements present in the provisioning profile; regenerate and re-upload `MACOS_PROVISIONING_PROFILE` after Apple approves managed capabilities. The CLI archive uses only `CSC_LINK`, `CSC_KEY_PASSWORD`, and the three `APPLE_API_*` secrets.

### Azure Trusted Signing (Windows)

Set secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` with an Entra service principal granted Trusted Signing permissions.

## Release checklist

1. Dispatch **Release** with the tag and `publish_draft` set (or leave it unset and review the draft).
2. Confirm every `CLI archive`, `Package`, and `Release checks` leg passed, then that `Upload assets & publish release` finished.
3. On a clean machine, run `curl -fsSL https://code.ankiel.com/install.sh | sh` and `ankiel --version`, and open the desktop download from `code.ankiel.com/download`.
