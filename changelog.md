# Changelog

## 0.3.0 - 2026-03-11

- Added automatic target collection creation when a collection listed in `collections` is missing.
- New collection schemas are imported from the source instance before record migration starts.
- Added relation target remapping during schema import when the referenced collection already exists in target.
- Updated `readme.md` to document automatic collection creation.

## 0.2.0 - 2026-03-11

- Added local PocketBase auto-start for both endpoints (`source` and `target`), including the `local -> local` scenario.
- Removed hardcoded `LOCAL_PB_BIN` and `LOCAL_PB_DATA_DIR`; now `pb.<name>.bin` and `pb.<name>.data` are used from config.
- Added a health check before starting local instances: already running servers are not restarted.
- Added support for legacy `dir` key as an alias for `data`.
- Added local endpoint deduplication by `host:port` and conflict validation for `bin/data`.
- Fixed and extended `pb-migrate.json.example`.
- Added `readme.md` with project description and configuration examples.
