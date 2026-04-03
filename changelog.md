# Changelog

## 0.9.0 - 2026-04-03

- Added root config field `no_data` with collection names whose records should not be transferred.
- `no_data` now works in `pb -> pb`, `pb -> file`, and `file -> pb` flows.
- Snapshot export writes empty arrays for `no_data` collections while still preserving their schemas when enabled.
- Updated `pb-migrate.json.example` and `readme.md` with `no_data` usage.

## 0.8.0 - 2026-03-31

- Added CLI config path support.
- You can now pass a custom config file as the first positional argument or via `--config` / `-c`.
- Updated `readme.md` with custom config launch examples.

## 0.7.0 - 2026-03-17

- Added a file-endpoint flag to export snapshots without collection schemas.
- Snapshot export can omit the `schemas` block when schema export is disabled.
- Updated `pb-migrate.json.example` and `readme.md` with schema-export flag usage and behavior.

## 0.6.0 - 2026-03-16

- Added root config flag `overwrite` to control whether existing target records are skipped or updated when IDs match.
- Applied `overwrite` to both `pb -> pb` migrations and `file -> pb` snapshot imports.
- Updated logging, `pb-migrate.json.example`, and `readme.md` to document overwrite behavior.

## 0.5.0 - 2026-03-16

- Added `file -> pb` mode to import JSON snapshots back into PocketBase.
- New snapshots now include exported collection schemas so missing target collections can be created during snapshot import.
- Added backward compatibility for older snapshots without `schemas`; they can still be imported into existing target collections.
- Snapshot import now skips PocketBase file fields with an explicit warning because uploaded binaries are not stored in the snapshot.
- Updated `readme.md` with snapshot import usage and limitations.

## 0.4.0 - 2026-03-11

- Added `pb -> file` export mode to dump selected collections into a JSON snapshot file.
- Added support for `type: "file"` endpoints in config and output path parsing from `data`/`path`.
- Added backward-compatible `direction` alias `"snapshot"` that resolves to a single configured file endpoint.
- Updated `pb-migrate.json.example` and `readme.md` with export configuration.

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
