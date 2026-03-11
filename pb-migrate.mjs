#!/usr/bin/env node
import PocketBase from "pocketbase";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_FILE = "pb-migrate.json";

const ts = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getConfigPath() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, CONFIG_FILE);
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
    url,
    user,
    password,
    bin: typeof bin === "string" && bin.trim() ? bin : null,
    data: typeof data === "string" && data.trim() ? data : null,
  };
}

async function readConfig() {
  const configPath = getConfigPath();
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

  return {
    configPath,
    configDir,
    targetKey,
    sourceKey,
    target: normalizeServer(pb[targetKey], targetKey),
    source: normalizeServer(pb[sourceKey], sourceKey),
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
  ].filter((server) => isLocalhostUrl(server.url));

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
  remoteSchema,
  remoteIdToName,
  targetNameToId,
  importingNames,
) {
  const payload = deepClone(remoteSchema);

  for (const field of payload.fields ?? []) {
    if (field.type !== "relation") continue;
    const remoteTargetCollectionId = field.options?.collectionId;
    if (!remoteTargetCollectionId) continue;

    const targetName = remoteIdToName.get(remoteTargetCollectionId);
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
  remoteIndex,
  localIndex,
  collections,
  remoteIdToName,
) {
  const missingNames = collections.filter(
    (name) => !localIndex.byName.has(name) && remoteIndex.byName.has(name),
  );
  const missingInSource = collections.filter((name) => !remoteIndex.byName.has(name));

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
      remoteIndex.byName.get(name),
      remoteIdToName,
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

/* ---------------- Main ---------------- */

async function main() {
  const {
    configPath,
    configDir,
    target,
    source,
    targetKey,
    sourceKey,
    collections,
  } = await readConfig();

  console.log(`[${ts()}] Config: ${configPath}`);
  console.log(`[${ts()}] Source (${sourceKey}): ${source.url}`);
  console.log(`[${ts()}] Target (${targetKey}): ${target.url}`);
  console.log(`[${ts()}] Import order: ${collections.join(" → ")}`);

  const localEndpoints = gatherLocalEndpoints(
    source,
    sourceKey,
    target,
    targetKey,
  );
  await ensureLocalPocketBases(localEndpoints, configDir);

  const remote = new PocketBase(source.url);
  const local = new PocketBase(target.url);

  await authSuperuser(
    remote,
    source.user,
    source.password,
    `source (${sourceKey})`,
  );
  await authSuperuser(
    local,
    target.user,
    target.password,
    `target (${targetKey})`,
  );

  const remoteIndex = await getCollectionsIndex(remote);
  let localIndex = await getCollectionsIndex(local);

  const remoteIdToName = new Map(remoteIndex.all.map((c) => [c.id, c.name]));
  localIndex = await ensureCollectionsExistInTarget(
    local,
    remoteIndex,
    localIndex,
    collections,
    remoteIdToName,
  );

  const allowedTargets = new Set(collections);

  const idMaps = new Map(collections.map((n) => [n, new Map()]));

  for (const name of collections) {
    console.log(`\n[${ts()}] === ${name} ===`);

    const remoteSchema = remoteIndex.byName.get(name);
    const localSchema = localIndex.byName.get(name);
    if (!remoteSchema || !localSchema) {
      console.warn(`[${ts()}] Skipped (schema not found)`);
      continue;
    }

    const relationFields = (remoteSchema.fields ?? []).filter(
      (f) => f.type === "relation",
    );
    const fileFields = (remoteSchema.fields ?? []).filter(
      (f) => f.type === "file",
    );

    const records = await listAllRecords(remote, name);
    console.log(`[${ts()}] Records: ${records.length}`);
    const existingLocalRecords = await listAllRecords(local, name);
    const existingLocalIds = new Set(existingLocalRecords.map((rec) => rec.id));
    console.log(
      `[${ts()}] Existing target records by id: ${existingLocalIds.size}`,
    );

    const map = idMaps.get(name);
    let ok = 0;
    let skippedExisting = 0;

    for (const r of records) {
      if (existingLocalIds.has(r.id)) {
        // keep relation remapping intact for dependent collections
        map.set(r.id, r.id);
        skippedExisting++;
        continue;
      }

      const data = pickRecordDataForCreate(r, localSchema);

      // remap relations to already imported collections
      remapRelations(
        data,
        relationFields,
        remoteIdToName,
        idMaps,
        allowedTargets,
      );

      // IMPORTANT: convert remote file names -> actual uploaded files
      await copyFileFields(remote, r, data, fileFields);

      try {
        const created = await local.collection(name).create(data);
        map.set(r.id, created.id);
        ok++;
      } catch (e) {
        const status = e?.status ?? e?.response?.status;
        const msg = e?.message ?? String(e);
        const errData = e?.data ? JSON.stringify(e.data, null, 2) : "";

        console.warn(`[${ts()}] FAIL ${name} ${r.id}: status=${status} ${msg}`);
        if (errData) console.warn(errData);
      }
    }

    console.log(
      `[${ts()}] Imported: ${ok}, skipped existing by id: ${skippedExisting}`,
    );
  }

  console.log(`\n[${ts()}] Migration completed`);
}

main().catch((e) => {
  console.error(`[${ts()}] ERROR:`, e);
  process.exit(1);
});
