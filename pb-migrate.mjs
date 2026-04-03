#!/usr/bin/env node
import PocketBase from "pocketbase";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_FILE = "pb-migrate.json";

const ts = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getDefaultConfigPath() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, CONFIG_FILE);
}

function parseCliOptions(argv = process.argv.slice(2)) {
  let configArg = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--config" || arg === "-c") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      configArg = value;
      i++;
      continue;
    }

    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) {
        throw new Error('Missing value for "--config"');
      }
      configArg = value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (!configArg) {
      configArg = arg;
      continue;
    }

    throw new Error(`Unexpected extra argument: ${arg}`);
  }

  return { configArg };
}

function resolveConfigPath(configArg) {
  if (!configArg) return getDefaultConfigPath();
  return path.isAbsolute(configArg)
    ? configArg
    : path.resolve(process.cwd(), configArg);
}

function normalizeServer(server, key) {
  if (!server || typeof server !== "object") {
    throw new Error(`Invalid server config for "${key}"`);
  }
  const { url, user, password, bin } = server;
  const data = server.data ?? server.dir;
  if (!url || !user || !password) {
    throw new Error(
      `Server "${key}" must include "url", "user" and "password"`,
    );
  }
  return {
    type: "pb",
    url,
    user,
    password,
    bin: typeof bin === "string" && bin.trim() ? bin : null,
    data: typeof data === "string" && data.trim() ? data : null,
  };
}

function normalizeFileEndpoint(fileEndpoint, key) {
  if (!fileEndpoint || typeof fileEndpoint !== "object") {
    throw new Error(`Invalid file endpoint config for "${key}"`);
  }

  const dataPath = fileEndpoint.data ?? fileEndpoint.path ?? fileEndpoint.file;
  const includeSchemas = fileEndpoint.schemas ?? true;
  if (typeof dataPath !== "string" || !dataPath.trim()) {
    throw new Error(
      `File endpoint "${key}" must include "data" (or "path") with output json path`,
    );
  }
  if (typeof includeSchemas !== "boolean") {
    throw new Error(`File endpoint "${key}" field "schemas" must be a boolean`);
  }

  return {
    type: "file",
    data: dataPath,
    schemas: includeSchemas,
  };
}

function normalizeEndpoint(endpoint, key) {
  if (endpoint?.type === "file") return normalizeFileEndpoint(endpoint, key);
  return normalizeServer(endpoint, key);
}

function resolveDirectionEndpoint(pb, key) {
  if (pb[key]) {
    return {
      resolvedKey: key,
      endpoint: normalizeEndpoint(pb[key], key),
      aliasUsed: false,
    };
  }

  if (key === "snapshot") {
    const fileEndpoints = Object.entries(pb).filter(
      ([, endpoint]) => endpoint?.type === "file",
    );
    if (fileEndpoints.length === 1) {
      const [resolvedKey, endpoint] = fileEndpoints[0];
      return {
        resolvedKey,
        endpoint: normalizeEndpoint(endpoint, resolvedKey),
        aliasUsed: true,
      };
    }
  }

  throw new Error(`Endpoint "${key}" from "direction" is missing in config.pb`);
}

async function readConfig(configArg = null) {
  const configPath = resolveConfigPath(configArg);
  const configDir = path.dirname(configPath);
  const raw = await readFile(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}`);
  }

  const direction = parsed?.direction;
  if (!Array.isArray(direction) || direction.length !== 2) {
    throw new Error(
      '"direction" must be an array with 2 items: [source, target]',
    );
  }

  const [sourceKey, targetKey] = direction;
  const pb = parsed?.pb;
  if (!pb || typeof pb !== "object") {
    throw new Error('"pb" object is missing in config');
  }

  const collections = parsed?.collections;
  if (!Array.isArray(collections) || collections.length === 0) {
    throw new Error('"collections" must be a non-empty array');
  }

  const overwrite = parsed?.overwrite ?? false;
  if (typeof overwrite !== "boolean") {
    throw new Error('"overwrite" must be a boolean');
  }

  const noData = parsed?.no_data ?? [];
  if (!Array.isArray(noData) || noData.some((name) => typeof name !== "string")) {
    throw new Error('"no_data" must be an array of collection names');
  }

  const sourceEntry = resolveDirectionEndpoint(pb, sourceKey);
  const targetEntry = resolveDirectionEndpoint(pb, targetKey);

  return {
    configPath,
    configDir,
    targetKey,
    sourceKey,
    targetResolvedKey: targetEntry.resolvedKey,
    sourceResolvedKey: sourceEntry.resolvedKey,
    targetAliasUsed: targetEntry.aliasUsed,
    sourceAliasUsed: sourceEntry.aliasUsed,
    target: targetEntry.endpoint,
    source: sourceEntry.endpoint,
    overwrite,
    noData,
    collections,
  };
}

/* ---------------- PocketBase startup ---------------- */

const localChildren = [];
let localShutdownHandlersInstalled = false;

function resolveFromConfigPath(configDir, maybeRelativePath) {
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.resolve(configDir, maybeRelativePath);
}

function healthUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/api/health`;
}

async function isPocketBaseHealthy(url) {
  try {
    const res = await fetch(healthUrl(url));
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForLocalPB(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPocketBaseHealthy(url)) return;
    await sleep(300);
  }
  throw new Error("Local PocketBase did not start in time");
}

function isLocalhostUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function getHttpBind(url) {
  const u = new URL(url);
  return u.port ? `${u.hostname}:${u.port}` : u.hostname;
}

function stopAllLocalPocketBases() {
  for (const proc of localChildren) {
    if (proc.child && !proc.child.killed) {
      console.log(`\n[${ts()}] Stopping local PocketBase (${proc.label})...`);
      proc.child.kill("SIGINT");
    }
  }
}

function installLocalShutdownHandlersOnce() {
  if (localShutdownHandlersInstalled) return;
  localShutdownHandlersInstalled = true;

  process.on("SIGINT", () => {
    stopAllLocalPocketBases();
    process.exit(0);
  });

  process.on("exit", () => {
    stopAllLocalPocketBases();
  });
}

function startLocalPocketBase(endpoint, configDir) {
  if (!endpoint.bin || !endpoint.data) {
    throw new Error(
      `Local endpoint "${endpoint.label}" must include "bin" and "data" in config`,
    );
  }

  const binPath = resolveFromConfigPath(configDir, endpoint.bin);
  const dataPath = resolveFromConfigPath(configDir, endpoint.data);
  console.log(
    `[${ts()}] Starting local PocketBase (${endpoint.label}): ${binPath} --dir=${dataPath}`,
  );

  // IMPORTANT: --http without "http://"
  const args = [
    "serve",
    `--http=${getHttpBind(endpoint.url)}`,
    `--dir=${dataPath}`,
  ];

  const child = spawn(binPath, args, {
    stdio: "inherit",
    cwd: configDir,
  });

  installLocalShutdownHandlersOnce();
  localChildren.push({ child, label: endpoint.label });

  return child;
}

function gatherLocalEndpoints(source, sourceKey, target, targetKey) {
  const entries = [
    { ...source, key: sourceKey },
    { ...target, key: targetKey },
  ].filter((server) => server.type === "pb" && isLocalhostUrl(server.url));

  const byBind = new Map();
  for (const entry of entries) {
    const bind = getHttpBind(entry.url);
    const existing = byBind.get(bind);
    if (!existing) {
      byBind.set(bind, {
        ...entry,
        bind,
        label: entry.key,
      });
      continue;
    }

    if (existing.bin && entry.bin && existing.bin !== entry.bin) {
      throw new Error(
        `Local endpoint conflict on "${bind}": different "bin" values for ${existing.label} and ${entry.key}`,
      );
    }
    if (existing.data && entry.data && existing.data !== entry.data) {
      throw new Error(
        `Local endpoint conflict on "${bind}": different "data" values for ${existing.label} and ${entry.key}`,
      );
    }

    existing.bin = existing.bin ?? entry.bin;
    existing.data = existing.data ?? entry.data;
    existing.label = `${existing.label}, ${entry.key}`;
  }

  return [...byBind.values()];
}

async function ensureLocalPocketBases(endpoints, configDir) {
  if (endpoints.length === 0) {
    console.log(
      `[${ts()}] Both servers are not localhost, skip local PocketBase startup`,
    );
    return;
  }

  for (const endpoint of endpoints) {
    const isUp = await isPocketBaseHealthy(endpoint.url);
    if (isUp) {
      console.log(
        `[${ts()}] Local PocketBase already running (${endpoint.label}) at ${endpoint.url}`,
      );
      continue;
    }

    if (!endpoint.bin || !endpoint.data) {
      throw new Error(
        `Local endpoint "${endpoint.label}" at ${endpoint.url} is offline and requires "bin" and "data" in config for auto-start`,
      );
    }

    startLocalPocketBase(endpoint, configDir);
  }

  for (const endpoint of endpoints) {
    console.log(
      `[${ts()}] Waiting for local PocketBase (${endpoint.label}) at ${endpoint.url}...`,
    );
    await waitForLocalPB(endpoint.url);
    console.log(
      `[${ts()}] Local PocketBase is up (${endpoint.label}) at ${endpoint.url}`,
    );
  }
}

/* ---------------- Auth & helpers ---------------- */

async function authSuperuser(pb, email, pass, label) {
  console.log(`[${ts()}] Authenticating ${label} superuser...`);
  await pb.collection("_superusers").authWithPassword(email, pass);
}

async function getCollectionsIndex(pb) {
  const all = await pb.collections.getFullList({ sort: "name" });
  return buildCollectionsIndex(all);
}

function buildCollectionsIndex(all) {
  return {
    all,
    byName: new Map(all.map((c) => [c.name, c])),
    byId: new Map(all.map((c) => [c.id, c])),
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function toMapByCollectionNameId(index) {
  return new Map(index.all.map((c) => [c.name, c.id]));
}

function buildCollectionImportPayload(
  sourceSchema,
  sourceIdToName,
  targetNameToId,
  importingNames,
) {
  const payload = deepClone(sourceSchema);

  for (const field of payload.fields ?? []) {
    if (field.type !== "relation") continue;
    const sourceTargetCollectionId = field.options?.collectionId;
    if (!sourceTargetCollectionId) continue;

    const targetName = sourceIdToName.get(sourceTargetCollectionId);
    if (!targetName) continue;

    const existingTargetId = targetNameToId.get(targetName);
    if (existingTargetId) {
      field.options.collectionId = existingTargetId;
      continue;
    }

    if (!importingNames.has(targetName)) {
      console.warn(
        `[${ts()}] WARN unresolved relation target "${targetName}" for collection "${payload.name}"`,
      );
    }
  }

  return payload;
}

async function ensureCollectionsExistInTarget(
  local,
  sourceIndex,
  localIndex,
  collections,
  sourceIdToName,
) {
  if (sourceIndex.all.length === 0) {
    return localIndex;
  }

  const missingNames = collections.filter(
    (name) => !localIndex.byName.has(name) && sourceIndex.byName.has(name),
  );
  const missingInSource = collections.filter((name) => !sourceIndex.byName.has(name));

  for (const name of missingInSource) {
    console.warn(
      `[${ts()}] WARN source collection "${name}" not found, target schema won't be created`,
    );
  }

  if (missingNames.length === 0) return localIndex;

  const targetNameToId = toMapByCollectionNameId(localIndex);
  const importingNames = new Set(missingNames);
  const payload = missingNames.map((name) =>
    buildCollectionImportPayload(
      sourceIndex.byName.get(name),
      sourceIdToName,
      targetNameToId,
      importingNames,
    ),
  );

  console.log(
    `[${ts()}] Creating missing target collections: ${missingNames.join(", ")}`,
  );
  await local.collections.import(payload, false);

  const updatedLocalIndex = await getCollectionsIndex(local);
  console.log(
    `[${ts()}] Created missing target collections: ${missingNames.join(", ")}`,
  );

  return updatedLocalIndex;
}

function getRelationCollectionNameMap(index) {
  return new Map(index.all.map((collection) => [collection.id, collection.name]));
}

function getSchemaForImport(sourceIndex, targetIndex, name) {
  return sourceIndex.byName.get(name) ?? targetIndex.byName.get(name) ?? null;
}

function dropFileFields(data, fileFields) {
  for (const field of fileFields) {
    delete data[field.name];
  }
}

function pickRecordDataForCreate(record, localSchema) {
  const data = {};
  for (const f of localSchema.fields ?? []) {
    if (record[f.name] !== undefined) {
      data[f.name] = deepClone(record[f.name]);
    }
  }
  return data;
}

function remapRelations(data, relationFields, remoteIdToName, idMaps, allowed) {
  for (const f of relationFields) {
    const targetId = f.options?.collectionId;
    if (!targetId) continue;

    const targetName = remoteIdToName.get(targetId);
    if (!allowed.has(targetName)) continue;

    const map = idMaps.get(targetName);
    if (!map) continue;

    const v = data[f.name];
    if (Array.isArray(v)) {
      data[f.name] = v.map((id) => map.get(id)).filter(Boolean);
    } else if (typeof v === "string") {
      data[f.name] = map.get(v) ?? null;
    }
  }
}

async function listAllRecords(pb, name) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await pb
      .collection(name)
      .getList(page, 200, { sort: "+created" });
    all.push(...res.items);
    if (res.items.length < 200) break;
    page++;
  }
  return all;
}

async function exportCollectionsToJson({
  sourcePb,
  sourceKey,
  sourceUrl,
  outputPath,
  configDir,
  includeSchemas = true,
  noData = new Set(),
  collections,
}) {
  const sourceIndex = await getCollectionsIndex(sourcePb);
  const snapshot = {
    snapshotVersion: 2,
    exportedAt: ts(),
    source: {
      key: sourceKey,
      url: sourceUrl,
    },
    collections: {},
  };
  if (includeSchemas) {
    snapshot.schemas = {};
  }

  for (const name of collections) {
    if (!sourceIndex.byName.has(name)) {
      console.warn(
        `[${ts()}] WARN source collection "${name}" not found, exporting as empty array`,
      );
      snapshot.collections[name] = [];
      continue;
    }

    if (includeSchemas) {
      snapshot.schemas[name] = deepClone(sourceIndex.byName.get(name));
    }
    if (noData.has(name)) {
      snapshot.collections[name] = [];
      console.log(`[${ts()}] Exported "${name}": 0 records (disabled by no_data)`);
      continue;
    }
    const records = await listAllRecords(sourcePb, name);
    snapshot.collections[name] = records.map((record) => deepClone(record));
    console.log(`[${ts()}] Exported "${name}": ${records.length} records`);
  }

  console.log(
    `[${ts()}] Snapshot schemas: ${includeSchemas ? "enabled" : "disabled by config"}`,
  );
  const outputAbsPath = resolveFromConfigPath(configDir, outputPath);
  await mkdir(path.dirname(outputAbsPath), { recursive: true });
  await writeFile(`${outputAbsPath}`, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`[${ts()}] Snapshot written to: ${outputAbsPath}`);
}

async function readSnapshotFile({ inputPath, configDir }) {
  const snapshotPath = resolveFromConfigPath(configDir, inputPath);
  const raw = await readFile(snapshotPath, "utf8");
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in snapshot file: ${snapshotPath}`);
  }

  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`Snapshot file must contain a JSON object: ${snapshotPath}`);
  }
  if (!snapshot.collections || typeof snapshot.collections !== "object") {
    throw new Error(`Snapshot file is missing "collections": ${snapshotPath}`);
  }

  return {
    snapshotPath,
    snapshot,
  };
}

function buildSnapshotSchemaIndex(snapshot) {
  const schemas = snapshot?.schemas;
  if (!schemas || typeof schemas !== "object") {
    return buildCollectionsIndex([]);
  }

  const all = Object.entries(schemas)
    .map(([name, schema]) => {
      if (!schema || typeof schema !== "object") return null;
      return {
        ...deepClone(schema),
        name: schema.name ?? name,
      };
    })
    .filter(Boolean);

  return buildCollectionsIndex(all);
}

function getSnapshotRecords(snapshot, name) {
  const entry = snapshot.collections?.[name];
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object" && Array.isArray(entry.records)) {
    return entry.records;
  }
  return [];
}

/* ---------------- Files support ---------------- */

async function fetchFileAsBlob(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`File download failed: ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  return new Blob([ab]);
}

function makeNamedFileFromBlob(blob, filename) {
  // Node 20+ exposes File; Node 22 yes
  if (typeof File !== "undefined") {
    return new File([blob], filename, {
      type: blob.type || "application/octet-stream",
    });
  }
  // Best-effort fallback if File isn't available
  blob.name = filename;
  return blob;
}

async function copyFileFields(remote, record, data, fileFields) {
  for (const f of fileFields) {
    const fieldName = f.name;
    const val = data[fieldName];
    if (!val) continue;

    const downloadOne = async (filename) => {
      const url = remote.files.getUrl(record, filename);
      const blob = await fetchFileAsBlob(url);
      return makeNamedFileFromBlob(blob, filename);
    };

    try {
      if (Array.isArray(val)) {
        const files = [];
        for (const filename of val) {
          if (!filename) continue;
          files.push(await downloadOne(filename));
          await sleep(50);
        }
        data[fieldName] = files;
      } else if (typeof val === "string") {
        data[fieldName] = await downloadOne(val);
      }
    } catch (e) {
      // If file transfer fails, drop this field so record creation can still succeed.
      console.warn(
        `[${ts()}] WARN file "${fieldName}" rec ${record.id}: ${e?.message ?? String(e)}`,
      );
      delete data[fieldName];
    }
  }
}

async function importCollectionsIntoTarget({
  sourceIndex,
  targetIndex,
  targetPb,
  collections,
  overwrite = false,
  noData = new Set(),
  relationCollectionNamesById,
  listSourceRecords,
  sourcePb = null,
  fileMode = "drop",
}) {
  const allowedTargets = new Set(collections);
  const idMaps = new Map(collections.map((name) => [name, new Map()]));

  for (const name of collections) {
    console.log(`\n[${ts()}] === ${name} ===`);

    const sourceSchema = getSchemaForImport(sourceIndex, targetIndex, name);
    const targetSchema = targetIndex.byName.get(name);
    if (!sourceSchema || !targetSchema) {
      console.warn(`[${ts()}] Skipped (schema not found)`);
      continue;
    }

    const relationFields = (sourceSchema.fields ?? []).filter(
      (field) => field.type === "relation",
    );
    const fileFields = (sourceSchema.fields ?? []).filter(
      (field) => field.type === "file",
    );

    if (fileMode === "drop" && fileFields.length > 0) {
      console.warn(
        `[${ts()}] WARN snapshot import for "${name}" skips file fields: ${fileFields.map((field) => field.name).join(", ")}`,
      );
    }

    if (noData.has(name)) {
      console.log(`[${ts()}] Records: 0 (disabled by no_data)`);
      console.log(`[${ts()}] Existing target records by id: skipped`);
      console.log(
        `[${ts()}] Imported: 0, overwritten: 0, skipped existing by id: 0`,
      );
      continue;
    }

    const records = await listSourceRecords(name);
    console.log(`[${ts()}] Records: ${records.length}`);
    const existingTargetRecords = await listAllRecords(targetPb, name);
    const existingTargetIds = new Set(existingTargetRecords.map((rec) => rec.id));
    console.log(
      `[${ts()}] Existing target records by id: ${existingTargetIds.size}`,
    );

    const map = idMaps.get(name);
    let ok = 0;
    let overwritten = 0;
    let skippedExisting = 0;

    for (const record of records) {
      const existsInTarget = existingTargetIds.has(record.id);
      if (existsInTarget) {
        map.set(record.id, record.id);
        if (!overwrite) {
          skippedExisting++;
          continue;
        }
      }

      const data = pickRecordDataForCreate(record, targetSchema);
      remapRelations(
        data,
        relationFields,
        relationCollectionNamesById,
        idMaps,
        allowedTargets,
      );

      if (fileMode === "copy") {
        await copyFileFields(sourcePb, record, data, fileFields);
      } else {
        dropFileFields(data, fileFields);
      }

      try {
        if (existsInTarget) {
          await targetPb.collection(name).update(record.id, data);
          overwritten++;
        } else {
          const created = await targetPb.collection(name).create(data);
          map.set(record.id, created.id);
          ok++;
        }
      } catch (e) {
        const status = e?.status ?? e?.response?.status;
        const msg = e?.message ?? String(e);
        const errData = e?.data ? JSON.stringify(e.data, null, 2) : "";

        console.warn(
          `[${ts()}] FAIL ${name} ${record.id}: status=${status} ${msg}`,
        );
        if (errData) console.warn(errData);
      }
    }

    console.log(
      `[${ts()}] Imported: ${ok}, overwritten: ${overwritten}, skipped existing by id: ${skippedExisting}`,
    );
  }
}

/* ---------------- Main ---------------- */

async function main() {
  const { configArg } = parseCliOptions();
  const {
    configPath,
    configDir,
    target,
    source,
    targetKey,
    sourceKey,
    targetResolvedKey,
    sourceResolvedKey,
    targetAliasUsed,
    sourceAliasUsed,
    overwrite,
    noData,
    collections,
  } = await readConfig(configArg);
  const noDataSet = new Set(noData);

  const sourceLabel = sourceAliasUsed
    ? `${sourceKey} -> ${sourceResolvedKey}`
    : sourceKey;
  const targetLabel = targetAliasUsed
    ? `${targetKey} -> ${targetResolvedKey}`
    : targetKey;

  console.log(`[${ts()}] Config: ${configPath}`);
  console.log(
    `[${ts()}] Source (${sourceLabel}): ${source.type === "pb" ? source.url : source.data}`,
  );
  console.log(
    `[${ts()}] Target (${targetLabel}): ${target.type === "pb" ? target.url : target.data}`,
  );
  console.log(`[${ts()}] Overwrite existing by id: ${overwrite}`);
  console.log(
    `[${ts()}] no_data collections: ${noData.length > 0 ? noData.join(", ") : "-"}`,
  );
  console.log(`[${ts()}] Collections: ${collections.join(" → ")}`);

  const localEndpoints = gatherLocalEndpoints(
    source,
    sourceLabel,
    target,
    targetLabel,
  );
  await ensureLocalPocketBases(localEndpoints, configDir);

  if (source.type === "pb" && target.type === "file") {
    const sourcePb = new PocketBase(source.url);
    await authSuperuser(
      sourcePb,
      source.user,
      source.password,
      `source (${sourceLabel})`,
    );

    await exportCollectionsToJson({
      sourcePb,
      sourceKey: sourceLabel,
      sourceUrl: source.url,
      outputPath: target.data,
      configDir,
      includeSchemas: target.schemas,
      noData: noDataSet,
      collections,
    });

    console.log(`\n[${ts()}] Export completed`);
    return;
  }

  if (source.type === "file" && target.type === "pb") {
    const { snapshotPath, snapshot } = await readSnapshotFile({
      inputPath: source.data,
      configDir,
    });
    console.log(`[${ts()}] Snapshot: ${snapshotPath}`);

    const targetPb = new PocketBase(target.url);
    await authSuperuser(
      targetPb,
      target.user,
      target.password,
      `target (${targetLabel})`,
    );

    const snapshotIndex = buildSnapshotSchemaIndex(snapshot);
    let targetIndex = await getCollectionsIndex(targetPb);
    const targetIdToName = getRelationCollectionNameMap(targetIndex);
    const snapshotIdToName =
      snapshotIndex.all.length > 0
        ? getRelationCollectionNameMap(snapshotIndex)
        : targetIdToName;

    if (snapshotIndex.all.length === 0) {
      const missingTargetCollections = collections.filter(
        (name) => !targetIndex.byName.has(name),
      );
      if (missingTargetCollections.length > 0) {
        console.warn(
          `[${ts()}] WARN snapshot has no schemas, missing target collections will be skipped: ${missingTargetCollections.join(", ")}`,
        );
      }
    }

    targetIndex = await ensureCollectionsExistInTarget(
      targetPb,
      snapshotIndex,
      targetIndex,
      collections,
      snapshotIdToName,
    );

    await importCollectionsIntoTarget({
      sourceIndex: snapshotIndex.all.length > 0 ? snapshotIndex : targetIndex,
      targetIndex,
      targetPb,
      collections,
      overwrite,
      noData: noDataSet,
      relationCollectionNamesById: snapshotIdToName,
      listSourceRecords: async (name) => getSnapshotRecords(snapshot, name),
      fileMode: "drop",
    });

    console.log(`\n[${ts()}] Import completed`);
    return;
  }

  if (source.type !== "pb" || target.type !== "pb") {
    throw new Error(
      `Unsupported direction: ${source.type} -> ${target.type}. Supported: pb -> pb, pb -> file, file -> pb`,
    );
  }

  const sourcePb = new PocketBase(source.url);
  const targetPb = new PocketBase(target.url);

  await authSuperuser(
    sourcePb,
    source.user,
    source.password,
    `source (${sourceLabel})`,
  );
  await authSuperuser(
    targetPb,
    target.user,
    target.password,
    `target (${targetLabel})`,
  );

  const sourceIndex = await getCollectionsIndex(sourcePb);
  let targetIndex = await getCollectionsIndex(targetPb);
  const sourceIdToName = getRelationCollectionNameMap(sourceIndex);

  targetIndex = await ensureCollectionsExistInTarget(
    targetPb,
    sourceIndex,
    targetIndex,
    collections,
    sourceIdToName,
  );

  await importCollectionsIntoTarget({
    sourceIndex,
    targetIndex,
    targetPb,
    collections,
    overwrite,
    noData: noDataSet,
    relationCollectionNamesById: sourceIdToName,
    listSourceRecords: async (name) => listAllRecords(sourcePb, name),
    sourcePb,
    fileMode: "copy",
  });

  console.log(`\n[${ts()}] Migration completed`);
}

main().catch((e) => {
  console.error(`[${ts()}] ERROR:`, e);
  process.exit(1);
});
