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
              imo: "9482902",
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
    registrations: {
      imo: "IMO 9482902",
    },
  });
  assert.equal(values.some((entry) => entry.path === "registrations.imo"), false);
  assert.deepEqual(values.find((entry) => entry.path === "design.length").value, {
    overall: 1000,
  });
  assert.equal(values.find((entry) => entry.path === "sensors.ais.fromBow").value, 860);
  assert.equal(values.find((entry) => entry.path === "sensors.ais.fromCenter").value, -12);
});

test("does not refill static data already present in the Signal K full model", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-current-model-test-"));
  const databasePath = path.join(tempDir, "vessels.json");
  const context = "vessels.urn:mrn:imo:mmsi:235900011";
  fs.writeFileSync(
    databasePath,
    `${JSON.stringify({
      version: 1,
      plugin: "signalk-ajrm-marine-vessel-database",
      vessels: {
        235900011: {
          mmsi: "235900011",
          fields: {
            name: "PRESENT VESSEL",
            imo: "9482902",
            length: 90,
          },
          fieldUpdatedAt: {},
        },
      },
    })}\n`,
  );

  const app = createFakeApp({
    [`${context}.name`]: "PRESENT VESSEL",
    [`${context}.registrations.imo`]: "IMO 9482902",
    [`${context}.design.length`]: { value: { overall: 90 } },
  });
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context,
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [{ path: "navigation.position", value: { latitude: 59.1, longitude: 23.2 } }],
      },
    ],
  });
  plugin.stop();

  assert.equal(app.messages.some((message) => message.context === context), false);
});

test("fills IMO as static data without replacing other registrations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-imo-test-"));
  const databasePath = path.join(tempDir, "vessels.json");
  const context = "vessels.urn:mrn:imo:mmsi:235900012";
  fs.writeFileSync(
    databasePath,
    `${JSON.stringify({
      version: 1,
      plugin: "signalk-ajrm-marine-vessel-database",
      vessels: {
        235900012: {
          mmsi: "235900012",
          fields: { imo: "IMO9482902" },
          fieldUpdatedAt: {},
        },
      },
    })}\n`,
  );

  const national = {
    GB: {
      country: "GB",
      registration: "SSR12345",
      description: "UK Small Ships Register",
    },
  };
  const app = createFakeApp({
    [`${context}.registrations`]: { national },
  });
  const plugin = createPlugin(app);
  plugin.start({
    databaseDirectory: tempDir,
    fillMissingData: true,
    publishSummary: false,
  });

  app.signalk.emit("delta", {
    context,
    updates: [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        values: [{ path: "navigation.position", value: { latitude: 59.1, longitude: 23.2 } }],
      },
    ],
  });
  plugin.stop();

  const fillMessage = app.messages.find((message) => message.context === context);
  const values = fillMessage.updates.flatMap((update) => update.values);
  assert.deepEqual(values, [
    {
      path: "",
      value: {
        registrations: {
          national,
          imo: "IMO 9482902",
        },
      },
    },
  ]);
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

function createFakeApp(pathValues = {}) {
  return {
    signalk: new EventEmitter(),
    messages: [],
    getPath(path) {
      return pathValues[path];
    },
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
