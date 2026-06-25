const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const createPlugin = require("../plugin");

test("fills persisted static data into a dynamic-only AIS vessel delta", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-test-"));
  const databasePath = path.join(tempDir, "vessels.json");
  fs.writeFileSync(
    databasePath,
    `${JSON.stringify(
      {
        version: 1,
        plugin: "signalk-ajrm-marine-vessel-database",
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        vessels: {
          235900001: {
            mmsi: "235900001",
            firstSeen: "2026-05-08T00:00:00.000Z",
            lastSeen: "2026-05-08T00:00:00.000Z",
            updatedAt: "2026-05-08T00:00:00.000Z",
            fields: {
              name: "NORTH CHANNEL",
              callsign: "VSA001",
              aisClass: "A",
              shipType: { id: 70, name: "Cargo" },
              length: 1000,
              beam: 80,
              aisFromBow: 860,
              aisFromCenter: -12,
            },
            fieldUpdatedAt: {},
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900001",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [
          {
            path: "navigation.position",
            value: { latitude: 59.1, longitude: 23.2 },
          },
          {
            path: "navigation.speedOverGround",
            value: 5.1,
          },
        ],
      },
    ],
  });

  plugin.stop();

  const fillMessage = app.messages.find(
    (message) => message.context === "vessels.urn:mrn:imo:mmsi:235900001",
  );
  assert.ok(fillMessage, "expected a fill message for the AIS vessel context");
  const values = fillMessage.updates.flatMap((update) => update.values);
  assert.deepEqual(
    values.map((entry) => entry.path).sort(),
    [
      "design.aisShipType",
      "design.beam",
      "design.length",
      "",
      "sensors.ais.class",
      "sensors.ais.fromBow",
      "sensors.ais.fromCenter",
    ].sort(),
  );
  assert.deepEqual(values.find((entry) => entry.path === "").value, {
    name: "NORTH CHANNEL",
    communication: {
      callsignVhf: "VSA001",
    },
  });
  assert.deepEqual(values.find((entry) => entry.path === "design.length").value, {
    overall: 1000,
  });
  assert.equal(values.find((entry) => entry.path === "sensors.ais.fromBow").value, 860);
  assert.equal(values.find((entry) => entry.path === "sensors.ais.fromCenter").value, -12);
});

test("fills names again after an earlier static AIS update", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-class-b-test-"));
  const databasePath = path.join(tempDir, "vessels.json");
  fs.writeFileSync(
    databasePath,
    `${JSON.stringify(
      {
        version: 1,
        plugin: "signalk-ajrm-marine-vessel-database",
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        vessels: {
          235900009: {
            mmsi: "235900009",
            firstSeen: "2026-05-08T00:00:00.000Z",
            lastSeen: "2026-05-08T00:00:00.000Z",
            updatedAt: "2026-05-08T00:00:00.000Z",
            fields: {
              name: "RIB ALPHA",
              callsign: "VSB009",
            },
            fieldUpdatedAt: {},
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900009",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [
          { path: "name", value: "RIB ALPHA" },
          { path: "communication.callsignVhf", value: "VSB009" },
        ],
      },
    ],
  });
  app.messages.length = 0;

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900009",
    updates: [
      {
        timestamp: "2026-05-08T12:01:00.000Z",
        values: [
          {
            path: "navigation.position",
            value: { latitude: 53.75, longitude: -4.7 },
          },
        ],
      },
    ],
  });

  plugin.stop();

  const fillMessage = app.messages.find(
    (message) => message.context === "vessels.urn:mrn:imo:mmsi:235900009",
  );
  assert.ok(fillMessage, "expected a fill message after the dynamic-only delta");
  const values = fillMessage.updates.flatMap((update) => update.values);
  assert.deepEqual(values.find((entry) => entry.path === "").value, {
    name: "RIB ALPHA",
    communication: {
      callsignVhf: "VSB009",
    },
  });
});

test("learns AIS GPS antenna offsets from standard sensor paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-ais-sensors-test-"));
  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900007",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [
          { path: "mmsi", value: "235900007" },
          { path: "sensors.ais.fromBow", value: 86.4 },
          { path: "sensors.ais.fromCenter", value: -1.5 },
        ],
      },
    ],
  });

  plugin.stop();

  const saved = JSON.parse(fs.readFileSync(path.join(tempDir, "vessels.json"), "utf8"));
  assert.equal(saved.vessels["235900007"].fields.aisFromBow, 86.4);
  assert.equal(saved.vessels["235900007"].fields.aisFromCenter, -1.5);
});

test("does not learn or fill vessels.self by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-self-test-"));
  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.self",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [
          {
            path: "name",
            value: "Test Own Vessel",
          },
        ],
      },
    ],
  });

  plugin.stop();

  assert.deepEqual(app.messages, []);
  assert.equal(fs.existsSync(path.join(tempDir, "vessels.json")), false);
});

test("ignores generic dimensions so assumed hull geometry is not learned", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-dimensions-test-"));
  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900007",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [
          { path: "mmsi", value: "235900007" },
          {
            path: "design.dimensions",
            value: {
              toBow: 7.5,
              toStern: 2.5,
              toPort: 1.25,
              toStarboard: 1.25,
            },
          },
          { path: "design.dimensionToBow", value: 7.5 },
          { path: "design.dimensionToStern", value: 2.5 },
        ],
      },
    ],
  });

  plugin.stop();

  assert.equal(fs.existsSync(path.join(tempDir, "vessels.json")), false);
});

test("ignores generic dimensions inside full vessel object snapshots", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-object-dimensions-test-"));
  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900007",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [
          {
            path: "",
            value: {
              mmsi: "235900007",
              design: {
                dimensions: {
                  toBow: 7.5,
                  toStern: 2.5,
                  toPort: 1.25,
                  toStarboard: 1.25,
                },
              },
            },
          },
        ],
      },
    ],
  });

  plugin.stop();

  assert.equal(fs.existsSync(path.join(tempDir, "vessels.json")), false);
});

test("scrubs legacy AIS reference dimensions without filling them back", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-ais-dimensions-test-"));
  const databasePath = path.join(tempDir, "vessels.json");
  fs.writeFileSync(
    databasePath,
    `${JSON.stringify(
      {
        version: 1,
        plugin: "signalk-ajrm-marine-vessel-database",
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        vessels: {
          235900008: {
            mmsi: "235900008",
            firstSeen: "2026-05-08T00:00:00.000Z",
            lastSeen: "2026-05-08T00:00:00.000Z",
            updatedAt: "2026-05-08T00:00:00.000Z",
            fields: {
              name: "MISTY DAWN",
              dimensionToBow: 7.5,
              dimensionToStern: 2.5,
              dimensionToPort: 1.25,
              dimensionToStarboard: 1.25,
            },
            fieldUpdatedAt: {},
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900008",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [{ path: "navigation.position", value: { latitude: 53.75, longitude: -4.7 } }],
      },
    ],
  });

  plugin.stop();

  const fillMessage = app.messages.find(
    (message) => message.context === "vessels.urn:mrn:imo:mmsi:235900008",
  );
  const values = fillMessage.updates.flatMap((update) => update.values);
  assert.deepEqual(
    values.map((entry) => entry.path),
    [""],
  );
  assert.deepEqual(values[0].value, { name: "MISTY DAWN" });
});

test("scrubs legacy reference dimensions when loading existing databases", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-scrub-test-"));
  const databasePath = path.join(tempDir, "vessels.json");
  fs.writeFileSync(
    databasePath,
    `${JSON.stringify(
      {
        version: 1,
        plugin: "signalk-ajrm-marine-vessel-database",
        vessels: {
          235900010: {
            mmsi: "235900010",
            firstSeen: "2026-05-08T00:00:00.000Z",
            lastSeen: "2026-05-08T00:00:00.000Z",
            updatedAt: "2026-05-08T00:00:00.000Z",
            fields: {
              name: "FISHER TWO",
              dimensionToBow: 7.5,
              dimensionToStern: 2.5,
              dimensionToPort: 1.25,
              dimensionToStarboard: 1.25,
            },
            fieldUpdatedAt: {
              dimensionToBow: "2026-05-08T00:00:00.000Z",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const app = createFakeApp();
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235900010",
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [{ path: "navigation.position", value: { latitude: 53.75, longitude: -4.7 } }],
      },
    ],
  });

  plugin.stop();

  const fillMessage = app.messages.find(
    (message) => message.context === "vessels.urn:mrn:imo:mmsi:235900010",
  );
  const values = fillMessage.updates.flatMap((update) => update.values);
  assert.deepEqual(values, [{ path: "", value: { name: "FISHER TWO" } }]);
  const saved = JSON.parse(fs.readFileSync(databasePath, "utf8"));
  assert.equal(saved.vessels["235900010"].fields.dimensionToBow, undefined);
});

function createFakeApp() {
  return {
    signalk: new EventEmitter(),
    messages: [],
    handleMessage(_id, message) {
      this.messages.push(message);
    },
    setPluginStatus() {},
    debug() {},
    error(error) {
      throw new Error(String(error));
    },
  };
}
