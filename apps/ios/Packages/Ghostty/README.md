# Ghostty for the native app

`GhosttyKit.xcframework` is the same prebuilt libghostty (terminal emulation plus its Metal
renderer, arm64 device and simulator slices) that `apps/mobile/modules/ankiel-terminal/Vendor`
ships, built from the custom-I/O branch named in `VERSION` and that folder's
`THIRD_PARTY_NOTICES.md` (MIT). Rebuild it with that module's `scripts/build-libghostty-ios16.sh`
and copy the result here; keep both copies identical so git stores them once.

`AnkielGhostty` re-exports the C API and links what it needs (Metal, IOSurface, libc++, zlib).
The app target links it directly; `AnkielKit` (and so the widget) does not.
