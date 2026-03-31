# pocketbase-migrate

A script for migrating records between two PocketBase instances.

Supported flows:

- `remote -> local`
- `local -> remote`
- `local -> local` (both instances can be started automatically)
- `pb -> file` (export records to JSON snapshot)
- `file -> pb` (import JSON snapshot back into PocketBase)

## Requirements

- Node.js 20+
- npm package `pocketbase`
- superuser access for source and target

## Config

Default file: `pb-migrate.json`

```json
{
  "pb": {
    "local_old": {
      "url": "http://127.0.0.1:8090",
      "user": "admin@pocketbase.com",
      "password": "PASS",
      "bin": "./pocketbase/pocketbase",
      "data": "./pocketbase-old/pb_data"
    },
    "local_new": {
      "url": "http://127.0.0.1:8091",
      "user": "admin@pocketbase.com",
      "password": "PASS",
      "bin": "./pocketbase/pocketbase",
      "data": "./pocketbase/pb_data"
    },
    "dev": {
      "url": "https://api.pocketbase.com",
      "user": "admin@pocketbase.com",
      "password": "PASS"
    },
    "file": {
      "type": "file",
      "schemas": true,
      "data": "./snapshot.json"
    }
  },
  "overwrite": false,
  "direction": ["local_old", "file"],
  "collections": ["tags", "locations", "prices"]
}
```

Fields:

- `pb.<name>.url` - PocketBase URL
- `pb.<name>.user` - superuser email
- `pb.<name>.password` - superuser password
- `pb.<name>.bin` - path to PocketBase binary (required only for local auto-start)
- `pb.<name>.data` - path to `pb_data` (required only for local auto-start)
- `pb.<name>.type` - set to `file` for JSON export endpoints
- `pb.<name>.schemas` - if `false`, export snapshot without collection schemas
- `pb.<name>.data` (for `type=file`) - output JSON file path
- `overwrite` - if `true`, update existing target records when IDs match
- `direction` - `[sourceKey, targetKey]`
- `collections` - migration order for collections

Notes:

- For local endpoints, the script first checks `/api/health`.
- If a local server is already running, `bin/data` are not used.
- If a local server is not running, `bin` and `data` are required.
- If a target collection from `collections` is missing, it is created from the source schema before record migration.
- If `overwrite=false`, existing target records with the same ID are skipped.
- If `overwrite=true`, existing target records with the same ID are updated in place.
- For `pb -> file`, all records from listed collections are exported into one JSON snapshot.
- If `pb.<name>.schemas=false`, exported snapshot will not contain `schemas`.
- New snapshots include collection schemas, so `file -> pb` can create missing target collections automatically.
- Old snapshots without `schemas` can still be imported, but only into already existing target collections.
- `file -> pb` skips PocketBase file fields because the snapshot stores record data, not uploaded binaries.
- Legacy alias: `direction` target can be `"snapshot"` if there is exactly one `type=file` endpoint in config.
- Legacy alias: `direction` source can also be `"snapshot"` under the same condition.
- For backward compatibility, `dir` can be used instead of `data`.

Modes:

- `pb -> pb`: migrate records from source PocketBase to target PocketBase.
- `pb -> file`: export source records to JSON snapshot.
- `file -> pb`: import snapshot records into target PocketBase.

Examples:

- Export snapshot: `direction: ["local_old", "file"]`
- Import snapshot: `direction: ["file", "local_new"]`
- Import snapshot using alias: `direction: ["snapshot", "local_new"]`

## Run

```bash
node pb-migrate.mjs
```

```bash
node pb-migrate.mjs ./configs/proxtopus.json
```

```bash
node pb-migrate.mjs --config ./configs/proxtopus.json
```
