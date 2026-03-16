# pocketbase-migrate

A script for migrating records between two PocketBase instances.

Supported flows:
- `remote -> local`
- `local -> remote`
- `local -> local` (both instances can be started automatically)
- `pb -> file` (export records to JSON snapshot)

## Requirements

- Node.js 20+
- npm package `pocketbase`
- superuser access for source and target

## Config

File: `pb-migrate.json`

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
      "data": "./snapshot.json"
    }
  },
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
- `pb.<name>.data` (for `type=file`) - output JSON file path
- `direction` - `[sourceKey, targetKey]`
- `collections` - migration order for collections

Notes:
- For local endpoints, the script first checks `/api/health`.
- If a local server is already running, `bin/data` are not used.
- If a local server is not running, `bin` and `data` are required.
- If a target collection from `collections` is missing, it is created from the source schema before record migration.
- For `pb -> file`, all records from listed collections are exported into one JSON snapshot.
- Legacy alias: `direction` target can be `"snapshot"` if there is exactly one `type=file` endpoint in config.
- For backward compatibility, `dir` can be used instead of `data`.

Modes:
- `pb -> pb`: migrate records from source PocketBase to target PocketBase.
- `pb -> file`: export source records to JSON snapshot.

## Run

```bash
node pb-migrate.mjs
```
