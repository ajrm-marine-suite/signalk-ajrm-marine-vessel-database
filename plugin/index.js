const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageInfo = require("../package.json");

const SUMMARY_PATH = "plugins.ajrmMarineVesselDatabase.summary";
const DEFAULT_FILE_NAME = "vessels.json";
const FILL_COOLDOWN_MS = 60_000;

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
const ROOT_STATIC_FILL_KEYS = new Set(["name", "callsign"]);
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

    router.delete("/vessels", (_req, res) => {
      clearDatabase();
      res.json({
        ok: true,
        status: buildStatus(),
      });
    });

    router.post("/delete-all", (_req, res) => {
      clearDatabase();
      res.json({
        ok: true,
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
      const value = record.fields[key];
      if (value === undefined) continue;
      if (!canFill(context, key)) continue;
      const signalKValue = toSignalKValue(key, value);
      if (signalKValue === undefined) continue;
      if (ROOT_STATIC_FILL_KEYS.has(key)) {
        mergeRootStaticValue(rootValue, key, signalKValue);
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
  return text ? text.replace(/^imo/i, "").trim() : undefined;
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
  return value;
}

function mergeRootStaticValue(rootValue, key, value) {
  if (key === "name") {
    rootValue.name = value;
    return;
  }
  if (key === "callsign") {
    rootValue.communication = {
      ...(rootValue.communication || {}),
      callsignVhf: value,
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
