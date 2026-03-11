# pocketbase-migrate

A script for migrating records between two PocketBase instances.

Supported flows:
- `remote -> local`
- `local -> remote`
- `local -> local` (both instances can be started automatically)

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
    }
  },
  "direction": ["local_old", "local_new"],
  "collections": ["tags", "locations", "prices"]
}
```

Fields:
- `pb.<name>.url` - PocketBase URL
- `pb.<name>.user` - superuser email
- `pb.<name>.password` - superuser password
- `pb.<name>.bin` - path to PocketBase binary (required only for local auto-start)
- `pb.<name>.data` - path to `pb_data` (required only for local auto-start)
- `direction` - `[sourceKey, targetKey]`
- `collections` - migration order for collections

Notes:
- For local endpoints, the script first checks `/api/health`.
- If a local server is already running, `bin/data` are not used.
- If a local server is not running, `bin` and `data` are required.
- If a target collection from `collections` is missing, it is created from the source schema before record migration.
- For backward compatibility, `dir` can be used instead of `data`.

## Run

```bash
node pb-migrate.mjs
```
