const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageInfo = require("../package.json");
const { ITU_MARS_URL, lookupItuMarsByMmsi } = require("./itu-mars");

const SUMMARY_PATH = "plugins.ajrmMarineVesselDatabase.summary";
const DEFAULT_FILE_NAME = "vessels.json";
const FILL_COOLDOWN_MS = 60_000;
const ONLINE_LOOKUP_DELAY_MS = 1_000;
const EXPORT_FORMAT = "ajrm-marine-vessel-database";
const BITE_TEST_MMSIS = Object.freeze([
  "235912345",
  "235912346",
  "235912347",
  "235912348",
  "235912349",
  "235912350",
  "235912351",
  "235912352",
  "235912353",
  "235912354",
  "235912355",
  "235912356",
  "235912357",
  "235912358",
  "235912359",
  "235900219",
]);

const FIELD_DEFS = [
  { key: "name", path: "name", type: "text" },
  { key: "callsign", path: "communication.callsignVhf", type: "text" },
  { key: "imo", path: "registrations.imo", type: "imo" },
  { key: "aisClass", path: "sensors.ais.class", type: "text" },
  { key: "shipType", path: "design.aisShipType", type: "shipType" },
  { key: "length", path: "design.length", type: "length" },
  { key: "beam", path: "design.beam", type: "number" },
  { key: "draft", path: "design.draft", type: "draft" },
  { key: "aisFromBow", path: "sensors.ais.fromBow", type: "number" },
  { key: "aisFromCenter", path: "sensors.ais.fromCenter", type: "signedNumber" },
];

const FIELD_BY_PATH = new Map(FIELD_DEFS.map((field) => [field.path, field]));
const FILLABLE_KEYS = [
  "name",
  "callsign",
  "imo",
  "aisClass",
  "shipType",
  "length",
  "beam",
  "draft",
  "aisFromBow",
  "aisFromCenter",
];
const ROOT_STATIC_FILL_KEYS = new Set(["name", "callsign", "imo"]);
const LEGACY_REFERENCE_DIMENSION_KEYS = [
  "dimensionToBow",
  "dimensionToStern",
  "dimensionToPort",
  "dimensionToStarboard",
];

module.exports = function ajrmMarineVesselDatabase(app) {
  const plugin = {};
  let options = normalizeOptions({}, app);
  let database = createEmptyDatabase();
  let deltaListener = null;
  let saveTimer = null;
  let lookupJob = createLookupJob();
  const fillTimes = new Map();
  const stats = {
    learned: 0,
    updated: 0,
    filled: 0,
    ignored: 0,
    errors: 0,
  };

  plugin.id = "signalk-ajrm-marine-vessel-database";
  plugin.name = "AJRM Marine Vessel Database";
  plugin.description =
    "Learns static AIS vessel details by MMSI and fills missing static details in Signal K.";

  plugin.schema = {
    type: "object",
    properties: {
      databaseDirectory: {
        type: "string",
        title: "Database directory",
        description:
          "Directory used to persist learned vessel details across Signal K restarts and Pi reboots.",
        default: defaultDatabaseDirectory(app),
      },
      fillMissingData: {
        type: "boolean",
        title: "Fill missing static data",
        description:
          "Publish known static details back into Signal K when a vessel is seen without them.",
        default: true,
      },
      learnOwnVessel: {
        type: "boolean",
        title: "Learn own vessel",
        description:
          "When disabled, AJRM Marine Vessel Database ignores vessels.self and only learns other AIS vessel contexts.",
        default: false,
      },
      publishSummary: {
        type: "boolean",
        title: "Publish summary",
        default: true,
      },
      fillCooldownSeconds: {
        type: "integer",
        title: "Fill cooldown seconds",
        default: 60,
        minimum: 5,
        maximum: 3600,
      },
    },
  };

  plugin.getOpenApi = () => require("./openApi.json");

  plugin.start = (pluginOptions = {}) => {
    options = normalizeOptions(pluginOptions, app);
    ensureDirectory(options.databaseDirectory);
    database = loadDatabase(options.databasePath);
    if (scrubLegacyReferenceDimensions(database)) scheduleSave();
    attachDeltaListener();
    publishSummary();
    app.setPluginStatus(`Started v${packageInfo.version}, ${countVessels()} vessels`);
  };

  plugin.stop = () => {
    lookupJob.cancelRequested = true;
    if (deltaListener) {
      app.signalk?.removeListener?.("delta", deltaListener);
      deltaListener = null;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveDatabase();
    }
  };

  plugin.registerWithRouter = function registerWithRouter(router) {
    router.get("/status", (_req, res) => {
      res.json(buildStatus());
    });

    router.get("/vessels", (_req, res) => {
      res.json({
        ok: true,
        vessels: listVessels(),
        status: buildStatus(),
      });
    });

    router.get("/export", (_req, res) => {
      const fileName = `ajrm-vessels-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.send(`${JSON.stringify(buildExportPayload(database), null, 2)}\n`);
    });

    router.post("/import", (req, res) => {
      try {
        if (lookupJob.running) {
          res.status(409).json({
            ok: false,
            error: "Cancel or finish the online lookup before importing a database",
          });
          return;
        }
        const mode = req.body?.mode === "replace" ? "replace" : "merge";
        const payload = req.body?.payload ?? req.body;
        const imported = importDatabasePayload(database, payload, mode);
        if (mode === "replace") writePreImportBackup();
        database = imported.database;
        fillTimes.clear();
        saveDatabase();
        publishSummary();
        app.setPluginStatus(
          `Imported ${imported.importedCount} vessels (${mode}) v${packageInfo.version}`,
        );
        res.json({ ok: true, ...imported.summary, status: buildStatus() });
      } catch (error) {
        stats.errors += 1;
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.get("/lookup/status", (_req, res) => {
      res.json({ ok: true, lookup: lookupStatus() });
    });

    router.post("/lookup/start", (_req, res) => {
      if (lookupJob.running) {
        res.status(409).json({ ok: false, error: "An online vessel lookup is already running" });
        return;
      }
      const candidates = lookupCandidates(database);
      lookupJob = createLookupJob(candidates.length);
      if (!candidates.length) {
        lookupJob.finishedAt = new Date().toISOString();
        res.json({ ok: true, lookup: lookupStatus() });
        return;
      }
      lookupJob.running = true;
      lookupJob.startedAt = new Date().toISOString();
      void runOnlineLookup(candidates);
      res.status(202).json({ ok: true, lookup: lookupStatus() });
    });

    router.post("/lookup/cancel", (_req, res) => {
      lookupJob.cancelRequested = true;
      res.json({ ok: true, lookup: lookupStatus() });
    });

    router.delete("/vessels", (_req, res) => {
      if (lookupJob.running) {
        res.status(409).json({ ok: false, error: "Cancel or finish the online lookup first" });
        return;
      }
      clearDatabase();
      res.json({
        ok: true,
        status: buildStatus(),
      });
    });

    router.delete("/vessels/:mmsi", (req, res) => {
      if (lookupJob.running) {
        res.status(409).json({ ok: false, error: "Cancel or finish the online lookup first" });
        return;
      }
      const mmsi = normalizeMmsi(req.params?.mmsi);
      if (!mmsi) {
        res.status(400).json({ ok: false, error: "A valid vessel MMSI is required" });
        return;
      }
      if (!removeVesselRecord(database, mmsi)) {
        res.status(404).json({ ok: false, error: `Vessel ${mmsi} is not in the database` });
        return;
      }
      for (const key of fillTimes.keys()) {
        if (key.includes(mmsi)) fillTimes.delete(key);
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      saveDatabase();
      publishSummary();
      app.setPluginStatus(`Deleted vessel ${mmsi}, ${countVessels()} vessels remain`);
      res.json({ ok: true, deletedMmsi: mmsi, status: buildStatus() });
    });

    router.post("/delete-all", (_req, res) => {
      if (lookupJob.running) {
        res.status(409).json({ ok: false, error: "Cancel or finish the online lookup first" });
        return;
      }
      clearDatabase();
      res.json({
        ok: true,
        status: buildStatus(),
      });
    });

    router.post("/delete-bite", (_req, res) => {
      if (lookupJob.running) {
        res.status(409).json({ ok: false, error: "Cancel or finish the online lookup first" });
        return;
      }
      const removedMmsis = removeBiteVesselRecords(database);
      if (removedMmsis.length) {
        for (const key of fillTimes.keys()) {
          if (removedMmsis.some((mmsi) => key.includes(mmsi))) fillTimes.delete(key);
        }
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        saveDatabase();
        publishSummary();
      }
      app.setPluginStatus(
        `Deleted ${removedMmsis.length} BITE test vessels, ${countVessels()} vessels remain`,
      );
      res.json({
        ok: true,
        removedCount: removedMmsis.length,
        removedMmsis,
        status: buildStatus(),
      });
    });
  };

  return plugin;

  function attachDeltaListener() {
    if (!app.signalk?.on) {
      app.debug(`[${plugin.id}] Signal K event emitter is not available`);
      return;
    }
    deltaListener = (delta) => {
      try {
        handleDelta(delta);
      } catch (error) {
        stats.errors += 1;
        app.error(`[${plugin.id}] delta handling failed: ${error.message}`);
      }
    };
    app.signalk.on("delta", deltaListener);
  }

  function handleDelta(delta) {
    if (!delta || typeof delta !== "object") return;
    if (delta.$source === plugin.id || delta.source?.label === plugin.id) return;

    for (const update of delta.updates || []) {
      const context = update.context || delta.context;
      if (!isVesselContext(context)) continue;
      if (!options.learnOwnVessel && context === "vessels.self") continue;
      handleUpdate(context, update);
    }
  }

  function handleUpdate(context, update) {
    const values = Array.isArray(update.values) ? update.values : [];
    if (!values.length) return;

    let mmsi = mmsiFromContext(context);
    const observed = {};

    for (const entry of values) {
      if (entry.path === "mmsi") {
        mmsi = normalizeMmsi(entry.value) || mmsi;
        continue;
      }
      if (entry.path === "") {
        Object.assign(observed, extractFromVesselObject(entry.value));
        continue;
      }

      const field = FIELD_BY_PATH.get(entry.path);
      if (!field) continue;
      const normalized = normalizeFieldValue(field, entry.value);
      if (normalized !== undefined) observed[field.key] = normalized;
    }

    if (!mmsi) {
      stats.ignored += 1;
      return;
    }

    learnFields(mmsi, observed, update.timestamp);
    fillMissingFields(context, mmsi, observed);
  }

  function learnFields(mmsi, fields, timestamp) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;

    const now = normalizeTimestamp(timestamp);
    let record = database.vessels[mmsi];
    if (!record) {
      record = {
        mmsi,
        firstSeen: now,
        lastSeen: now,
        updatedAt: now,
        fields: {},
        fieldUpdatedAt: {},
      };
      database.vessels[mmsi] = record;
      stats.learned += 1;
    }

    let changed = false;
    record.lastSeen = now;

    for (const [key, value] of entries) {
      if (!sameValue(record.fields[key], value)) {
        record.fields[key] = value;
        record.fieldUpdatedAt[key] = now;
        record.updatedAt = now;
        changed = true;
      }
    }

    if (changed) {
      database.updatedAt = now;
      stats.updated += 1;
      scheduleSave();
      publishSummary();
    }
  }

  function fillMissingFields(context, mmsi, liveFields) {
    if (!options.fillMissingData) return;
    const record = database.vessels[mmsi];
    if (!record?.fields) return;

    const values = [];
    const rootValue = {};
    for (const key of FILLABLE_KEYS) {
      if (liveFields[key] !== undefined) continue;
      if (currentFieldIsPresent(context, key)) continue;
      const value = record.fields[key];
      if (value === undefined) continue;
      const signalKValue = toSignalKValue(key, value);
      if (signalKValue === undefined) continue;
      if (!canFill(context, key)) continue;
      if (ROOT_STATIC_FILL_KEYS.has(key)) {
        mergeRootStaticValue(
          rootValue,
          key,
          signalKValue,
          key === "imo" ? currentRegistrations(context) : undefined,
        );
        continue;
      }
      values.push({ path: pathForKey(key), value: signalKValue });
    }

    if (Object.keys(rootValue).length) {
      values.unshift({ path: "", value: rootValue });
    }

    if (!values.length) return;

    stats.filled += values.length;
    app.handleMessage(plugin.id, {
      context,
      updates: [
        {
          timestamp: new Date().toISOString(),
          values,
        },
      ],
    });
    publishSummary();
  }

  function currentFieldIsPresent(context, key) {
    if (typeof app.getPath !== "function") return false;
    const field = FIELD_BY_PATH.get(pathForKey(key));
    if (!field) return false;
    const currentValue = app.getPath(`${context}.${field.path}`);
    return normalizeFieldValue(field, currentValue) !== undefined;
  }

  function currentRegistrations(context) {
    if (typeof app.getPath !== "function") return {};
    const registrations = app.getPath(`${context}.registrations`);
    return registrations && typeof registrations === "object" && !Array.isArray(registrations)
      ? registrations
      : {};
  }

  function canFill(context, key) {
    const now = Date.now();
    const fillKey = `${context}:${key}`;
    const last = fillTimes.get(fillKey) || 0;
    if (now - last < options.fillCooldownMs) return false;
    fillTimes.set(fillKey, now);
    return true;
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveDatabase();
    }, 500);
  }

  function saveDatabase() {
    try {
      ensureDirectory(options.databaseDirectory);
      const payload = {
        ...database,
        version: 1,
        plugin: plugin.id,
        updatedAt: database.updatedAt || new Date().toISOString(),
      };
      const temporaryPath = `${options.databasePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
      fs.renameSync(temporaryPath, options.databasePath);
    } catch (error) {
      stats.errors += 1;
      app.error(`[${plugin.id}] save failed: ${error.message}`);
    }
  }

  function writePreImportBackup() {
    ensureDirectory(options.databaseDirectory);
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(options.databaseDirectory, `vessels.before-import-${suffix}.json`);
    fs.writeFileSync(backupPath, `${JSON.stringify(database, null, 2)}\n`);
  }

  async function runOnlineLookup(candidates) {
    for (let index = 0; index < candidates.length; index += 1) {
      if (lookupJob.cancelRequested) break;
      const mmsi = candidates[index];
      lookupJob.currentMmsi = mmsi;
      try {
        const result = await lookupItuMarsByMmsi(mmsi);
        if (lookupJob.cancelRequested) break;
        const record = database.vessels[mmsi];
        if (!record) {
          lookupJob.notFound += 1;
        } else if (!result) {
          record.onlineLookup = lookupEvidence("not-found");
          lookupJob.notFound += 1;
        } else {
          const changed = applyLookupResult(record, result);
          lookupJob.matched += 1;
          if (changed) {
            lookupJob.updated += 1;
            stats.updated += 1;
          }
          scheduleSave();
        }
      } catch (error) {
        lookupJob.failed += 1;
        lookupJob.lastError = `${mmsi}: ${error.message}`;
        app.debug(`[${plugin.id}] ITU MARS lookup failed for ${mmsi}: ${error.message}`);
      }
      lookupJob.processed += 1;
      publishSummary();
      if (index < candidates.length - 1 && !lookupJob.cancelRequested) {
        await delay(ONLINE_LOOKUP_DELAY_MS);
      }
    }
    lookupJob.currentMmsi = null;
    lookupJob.running = false;
    lookupJob.cancelled = lookupJob.cancelRequested;
    lookupJob.finishedAt = new Date().toISOString();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveDatabase();
    publishSummary();
    app.setPluginStatus(
      `Online lookup ${lookupJob.cancelled ? "cancelled" : "finished"}: ${lookupJob.updated} updated, ${lookupJob.failed} failed`,
    );
  }

  function applyLookupResult(record, result) {
    const now = new Date().toISOString();
    let changed = false;
    record.fields ||= {};
    record.fieldUpdatedAt ||= {};
    for (const key of ["name", "callsign", "imo"]) {
      if (record.fields[key] !== undefined || result[key] === undefined) continue;
      const field = FIELD_DEFS.find((candidate) => candidate.key === key);
      const normalized = normalizeFieldValue(field, result[key]);
      if (normalized === undefined) continue;
      record.fields[key] = normalized;
      record.fieldUpdatedAt[key] = now;
      changed = true;
    }
    const ituMars = normalizeItuMarsDetail(result.detail);
    if (ituMars && !sameValue(record.fields.ituMars, ituMars)) {
      record.fields.ituMars = ituMars;
      record.fieldUpdatedAt.ituMars = now;
      changed = true;
    }
    record.onlineLookup = lookupEvidence("matched", result);
    record.updatedAt = changed ? now : record.updatedAt;
    if (changed) database.updatedAt = now;
    return changed;
  }

  function lookupEvidence(status, result = {}) {
    return {
      status,
      source: "ITU MARS",
      sourceUrl: ITU_MARS_URL,
      checkedAt: new Date().toISOString(),
      ...(result.mmsi ? { matchedMmsi: result.mmsi } : {}),
    };
  }

  function lookupStatus() {
    return {
      running: lookupJob.running,
      cancelRequested: lookupJob.cancelRequested,
      cancelled: lookupJob.cancelled,
      total: lookupJob.total,
      processed: lookupJob.processed,
      matched: lookupJob.matched,
      updated: lookupJob.updated,
      notFound: lookupJob.notFound,
      failed: lookupJob.failed,
      currentMmsi: lookupJob.currentMmsi,
      startedAt: lookupJob.startedAt,
      finishedAt: lookupJob.finishedAt,
      lastError: lookupJob.lastError,
      source: "ITU MARS",
      sourceUrl: ITU_MARS_URL,
    };
  }

  function clearDatabase() {
    database = createEmptyDatabase();
    fillTimes.clear();
    saveDatabase();
    publishSummary();
    app.setPluginStatus(`Cleared v${packageInfo.version}`);
  }

  function publishSummary() {
    if (!options.publishSummary) return;
    app.handleMessage(plugin.id, {
      context: "vessels.self",
      updates: [
        {
          timestamp: new Date().toISOString(),
          values: [
            {
              path: SUMMARY_PATH,
              value: buildStatus(),
            },
          ],
        },
      ],
    });
  }

  function buildStatus() {
    return {
      plugin: plugin.id,
      version: packageInfo.version,
      vesselCount: countVessels(),
      databasePath: options.databasePath,
      fillMissingData: options.fillMissingData,
      biteVesselCount: biteVesselMmsis(database).length,
      lookup: lookupStatus(),
      stats: { ...stats },
    };
  }

  function countVessels() {
    return Object.keys(database.vessels || {}).length;
  }

  function listVessels() {
    return Object.values(database.vessels || {})
      .map((record) => ({
        mmsi: record.mmsi,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        updatedAt: record.updatedAt,
        onlineLookup: record.onlineLookup,
        ...record.fields,
      }))
      .sort((a, b) => {
        const left = String(a.name || a.mmsi || "");
        const right = String(b.name || b.mmsi || "");
        return left.localeCompare(right);
      });
  }
};

function createEmptyDatabase() {
  const now = new Date().toISOString();
  return {
    version: 1,
    plugin: "signalk-ajrm-marine-vessel-database",
    createdAt: now,
    updatedAt: now,
    vessels: {},
  };
}

function removeVesselRecord(database, mmsi, timestamp = new Date().toISOString()) {
  const normalizedMmsi = normalizeMmsi(mmsi);
  if (!normalizedMmsi || !Object.hasOwn(database?.vessels || {}, normalizedMmsi)) return false;
  delete database.vessels[normalizedMmsi];
  database.updatedAt = normalizeTimestamp(timestamp);
  return true;
}

function biteVesselMmsis(database) {
  return BITE_TEST_MMSIS.filter((mmsi) => Object.hasOwn(database?.vessels || {}, mmsi));
}

function removeBiteVesselRecords(database, timestamp = new Date().toISOString()) {
  const mmsis = biteVesselMmsis(database);
  for (const mmsi of mmsis) delete database.vessels[mmsi];
  if (mmsis.length) database.updatedAt = normalizeTimestamp(timestamp);
  return mmsis;
}

function createLookupJob(total = 0) {
  return {
    running: false,
    cancelRequested: false,
    cancelled: false,
    total,
    processed: 0,
    matched: 0,
    updated: 0,
    notFound: 0,
    failed: 0,
    currentMmsi: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };
}

function lookupCandidates(database) {
  return Object.values(database?.vessels || {})
    .filter((record) => !normalizeText(record?.fields?.name) || !normalizeText(record?.fields?.callsign))
    .map((record) => normalizeMmsi(record.mmsi))
    .filter(Boolean)
    .sort();
}

function buildExportPayload(database) {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    vessels: Object.values(database?.vessels || {})
      .map((record) => ({
        mmsi: record.mmsi,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        updatedAt: record.updatedAt,
        ...record.fields,
        fieldUpdatedAt: record.fieldUpdatedAt,
        onlineLookup: record.onlineLookup,
      }))
      .sort((left, right) => String(left.mmsi).localeCompare(String(right.mmsi))),
  };
}

function importDatabasePayload(currentDatabase, payload, mode = "merge") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Import file must contain a JSON object");
  }
  if (payload.format !== undefined && payload.format !== EXPORT_FORMAT) {
    throw new Error(`Unsupported import format: ${payload.format}`);
  }
  if (!Array.isArray(payload.vessels)) {
    throw new Error("Import file must contain a vessels array");
  }
  const now = new Date().toISOString();
  const records = payload.vessels.map((item, index) => normalizeImportedRecord(item, index, now));
  const seen = new Set();
  for (const item of records) {
    if (seen.has(item.mmsi)) throw new Error(`Duplicate MMSI in import: ${item.mmsi}`);
    seen.add(item.mmsi);
  }

  const database = mode === "replace" ? createEmptyDatabase() : cloneDatabase(currentDatabase);
  let added = 0;
  let updated = 0;
  for (const item of records) {
    const existing = database.vessels[item.mmsi];
    const fields = mode === "replace" ? {} : { ...(existing?.fields || {}) };
    const fieldUpdatedAt = mode === "replace" ? {} : { ...(existing?.fieldUpdatedAt || {}) };
    for (const [key, operation] of Object.entries(item.fieldOperations)) {
      if (operation === undefined) {
        delete fields[key];
        delete fieldUpdatedAt[key];
      } else {
        fields[key] = operation;
        fieldUpdatedAt[key] = item.fieldUpdatedAt[key] || now;
      }
    }
    database.vessels[item.mmsi] = {
      mmsi: item.mmsi,
      firstSeen: item.firstSeen || existing?.firstSeen || now,
      lastSeen: item.lastSeen || existing?.lastSeen || now,
      updatedAt: item.updatedAt || now,
      fields,
      fieldUpdatedAt,
      ...(item.onlineLookup || existing?.onlineLookup
        ? { onlineLookup: item.onlineLookup || existing.onlineLookup }
        : {}),
    };
    if (existing) updated += 1;
    else added += 1;
  }
  database.version = 1;
  database.plugin = "signalk-ajrm-marine-vessel-database";
  database.updatedAt = now;
  return {
    database,
    importedCount: records.length,
    summary: { mode, imported: records.length, added, updated, total: Object.keys(database.vessels).length },
  };
}

function normalizeImportedRecord(item, index, now) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Vessel ${index + 1} must be a JSON object`);
  }
  const mmsi = normalizeMmsi(item.mmsi);
  if (!mmsi) throw new Error(`Vessel ${index + 1} has an invalid MMSI`);
  const knownKeys = new Set([
    "mmsi",
    "firstSeen",
    "lastSeen",
    "updatedAt",
    "fieldUpdatedAt",
    "onlineLookup",
    "ituMars",
    ...FIELD_DEFS.map((field) => field.key),
  ]);
  const unknownKey = Object.keys(item).find((key) => !knownKeys.has(key));
  if (unknownKey) throw new Error(`Vessel ${mmsi} has an unknown field: ${unknownKey}`);

  const fieldOperations = {};
  for (const field of FIELD_DEFS) {
    if (!Object.hasOwn(item, field.key)) continue;
    if (item[field.key] === null || item[field.key] === "") {
      fieldOperations[field.key] = undefined;
      continue;
    }
    const normalized = normalizeFieldValue(field, item[field.key]);
    if (normalized === undefined) {
      throw new Error(`Vessel ${mmsi} has an invalid ${field.key}`);
    }
    fieldOperations[field.key] = normalized;
  }
  if (Object.hasOwn(item, "ituMars")) {
    if (item.ituMars === null) fieldOperations.ituMars = undefined;
    else {
      const detail = normalizeItuMarsDetail(item.ituMars);
      if (!detail) throw new Error(`Vessel ${mmsi} has invalid ITU MARS details`);
      fieldOperations.ituMars = detail;
    }
  }
  return {
    mmsi,
    firstSeen: optionalTimestamp(item.firstSeen, `Vessel ${mmsi} firstSeen`),
    lastSeen: optionalTimestamp(item.lastSeen, `Vessel ${mmsi} lastSeen`),
    updatedAt: optionalTimestamp(item.updatedAt, `Vessel ${mmsi} updatedAt`) || now,
    fieldOperations,
    fieldUpdatedAt: normalizeFieldUpdatedAt(item.fieldUpdatedAt, mmsi),
    onlineLookup: normalizeOnlineLookup(item.onlineLookup, mmsi),
  };
}

const ITU_MARS_DETAIL_KEYS = [
  "administration",
  "administrationCode",
  "geographicalArea",
  "geographicalAreaCode",
  "generalClassification",
  "primaryClassification",
  "secondaryClassification",
  "vesselIdentificationNumber",
  "grossTonnage",
  "personCapacity",
  "radioInstallation",
  "recordUpdatedAt",
];

function normalizeItuMarsDetail(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ITU_MARS_DETAIL_KEYS) {
    const text = normalizeText(value[key]);
    if (text) result[key] = text;
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeOnlineLookup(value, mmsi) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Vessel ${mmsi} has invalid onlineLookup metadata`);
  }
  const result = {};
  for (const key of ["status", "source", "sourceUrl", "matchedMmsi"]) {
    const text = normalizeText(value[key]);
    if (text) result[key] = text;
  }
  if (value.checkedAt !== undefined) {
    result.checkedAt = optionalTimestamp(value.checkedAt, `Vessel ${mmsi} onlineLookup.checkedAt`);
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeFieldUpdatedAt(value, mmsi) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Vessel ${mmsi} has invalid fieldUpdatedAt metadata`);
  }
  const result = {};
  for (const [key, timestamp] of Object.entries(value)) {
    if (![...FIELD_DEFS.map((field) => field.key), "ituMars"].includes(key)) continue;
    result[key] = optionalTimestamp(timestamp, `Vessel ${mmsi} fieldUpdatedAt.${key}`);
  }
  return result;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp`);
  return new Date(parsed).toISOString();
}

function cloneDatabase(database) {
  return JSON.parse(JSON.stringify(database || createEmptyDatabase()));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadDatabase(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return createEmptyDatabase();
    if (!parsed.vessels || typeof parsed.vessels !== "object") {
      parsed.vessels = {};
    }
    return parsed;
  } catch {
    return createEmptyDatabase();
  }
}

function scrubLegacyReferenceDimensions(database) {
  let changed = false;
  for (const record of Object.values(database.vessels || {})) {
    if (!record?.fields) continue;
    for (const key of LEGACY_REFERENCE_DIMENSION_KEYS) {
      if (record.fields[key] !== undefined || record.fieldUpdatedAt?.[key] !== undefined) {
        changed = true;
      }
      delete record.fields[key];
      delete record.fieldUpdatedAt?.[key];
    }
  }
  return changed;
}

function normalizeOptions(value = {}, app) {
  const databaseDirectory = expandHome(
    String(value.databaseDirectory || defaultDatabaseDirectory(app)),
  );
  return {
    databaseDirectory,
    databasePath: path.join(databaseDirectory, DEFAULT_FILE_NAME),
    fillMissingData: value.fillMissingData !== false,
    learnOwnVessel: value.learnOwnVessel === true,
    publishSummary: value.publishSummary !== false,
    fillCooldownMs: clampInteger(value.fillCooldownSeconds, 60, 5, 3600) * 1000,
  };
}

function defaultDatabaseDirectory(app) {
  return path.join(os.homedir(), ".signalk", "plugin-config-data", "vessel-database");
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function isVesselContext(context) {
  return typeof context === "string" && context.startsWith("vessels.");
}

function mmsiFromContext(context) {
  const match = String(context || "").match(/mmsi:(\d{7,9})/i);
  return match ? normalizeMmsi(match[1]) : undefined;
}

function normalizeMmsi(value) {
  const text = String(signalKText(value) || "").trim();
  return /^\d{7,9}$/.test(text) ? text.padStart(9, "0") : undefined;
}

function extractFromVesselObject(value) {
  const fields = {};
  if (!value || typeof value !== "object") return fields;

  fields.name = normalizeText(value.name);
  fields.callsign = normalizeText(value.communication?.callsignVhf);
  fields.imo = normalizeImo(value.registrations?.imo);
  fields.aisClass = normalizeText(value.sensors?.ais?.class);
  fields.shipType = normalizeShipType(value.design?.aisShipType);
  fields.length = normalizeLength(value.design?.length);
  fields.beam = normalizeNumber(value.design?.beam);
  fields.draft = normalizeDraft(value.design?.draft);
  fields.aisFromBow = normalizeNumber(value.sensors?.ais?.fromBow);
  fields.aisFromCenter = normalizeSignedNumber(value.sensors?.ais?.fromCenter);

  return Object.fromEntries(Object.entries(fields).filter(([, item]) => item !== undefined));
}

function normalizeFieldValue(field, value) {
  switch (field.type) {
    case "text":
      return normalizeText(value);
    case "imo":
      return normalizeImo(value);
    case "shipType":
      return normalizeShipType(value);
    case "length":
      return normalizeLength(value);
    case "draft":
      return normalizeDraft(value);
    case "number":
      return normalizeNumber(value);
    case "signedNumber":
      return normalizeSignedNumber(value);
    default:
      return undefined;
  }
}

function normalizeText(value) {
  const text = signalKText(value);
  if (!text) return undefined;
  const trimmed = String(text).trim();
  return trimmed ? trimmed : undefined;
}

function normalizeImo(value) {
  const text = normalizeText(value);
  if (!text) return undefined;
  const match = text.match(/^(?:IMO\s*)?([0-9]{7})$/i);
  return match ? match[1] : undefined;
}

function normalizeShipType(value) {
  const raw = value?.value ?? value;
  if (!raw || typeof raw !== "object") return undefined;
  const id = normalizeNumber(raw.id);
  const name = normalizeText(raw.name);
  if (id === undefined && !name) return undefined;
  return { id, name };
}

function normalizeLength(value) {
  const raw = value?.value ?? value;
  if (typeof raw === "object" && raw) return normalizeNumber(raw.overall ?? raw.value);
  return normalizeNumber(raw);
}

function normalizeDraft(value) {
  const raw = value?.value ?? value;
  if (typeof raw === "object" && raw) return normalizeNumber(raw.current ?? raw.value);
  return normalizeNumber(raw);
}

function signalKText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return signalKText(value.value ?? value.name);
  }
  return undefined;
}

function normalizeNumber(value) {
  const raw = value?.value ?? value;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeSignedNumber(value) {
  const raw = value?.value ?? value;
  const number = Number(raw);
  return Number.isFinite(number) ? number : undefined;
}

function pathForKey(key) {
  return {
    name: "name",
    callsign: "communication.callsignVhf",
    imo: "registrations.imo",
    aisClass: "sensors.ais.class",
    shipType: "design.aisShipType",
    length: "design.length",
    beam: "design.beam",
    draft: "design.draft",
    aisFromBow: "sensors.ais.fromBow",
    aisFromCenter: "sensors.ais.fromCenter",
  }[key];
}

function toSignalKValue(key, value) {
  if (key === "length") return { overall: value };
  if (key === "draft") return { current: value };
  if (key === "imo") {
    const imo = normalizeImo(value);
    return imo ? `IMO ${imo}` : undefined;
  }
  return value;
}

function mergeRootStaticValue(rootValue, key, value, existingRegistrations = {}) {
  if (key === "name") {
    rootValue.name = value;
    return;
  }
  if (key === "callsign") {
    rootValue.communication = {
      ...(rootValue.communication || {}),
      callsignVhf: value,
    };
    return;
  }
  if (key === "imo") {
    rootValue.registrations = {
      ...existingRegistrations,
      ...(rootValue.registrations || {}),
      imo: value,
    };
  }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

module.exports.normalizeOptions = normalizeOptions;
module.exports.extractFromVesselObject = extractFromVesselObject;
module.exports.mmsiFromContext = mmsiFromContext;
module.exports.buildExportPayload = buildExportPayload;
module.exports.importDatabasePayload = importDatabasePayload;
module.exports.lookupCandidates = lookupCandidates;
module.exports.normalizeItuMarsDetail = normalizeItuMarsDetail;
module.exports.removeVesselRecord = removeVesselRecord;
module.exports.BITE_TEST_MMSIS = BITE_TEST_MMSIS;
module.exports.biteVesselMmsis = biteVesselMmsis;
module.exports.removeBiteVesselRecords = removeBiteVesselRecords;
