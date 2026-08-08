const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const createPlugin = require("../plugin");
const {
  BITE_TEST_MMSIS,
  biteVesselMmsis,
  removeBiteVesselRecords,
  removeVesselRecord,
} = createPlugin;

test("removes only the vessel with the exact normalized MMSI", () => {
  const database = {
    updatedAt: "2026-08-01T00:00:00.000Z",
    vessels: {
      232035943: { mmsi: "232035943", fields: { name: "EVE" } },
      235900001: { mmsi: "235900001", fields: { name: "OTHER" } },
    },
  };

  assert.equal(removeVesselRecord(database, "232035943", "2026-08-03T15:00:00.000Z"), true);
  assert.equal(database.vessels["232035943"], undefined);
  assert.equal(database.vessels["235900001"].fields.name, "OTHER");
  assert.equal(database.updatedAt, "2026-08-03T15:00:00.000Z");
  assert.equal(removeVesselRecord(database, "232035943"), false);
  assert.equal(removeVesselRecord(database, "not-an-mmsi"), false);
});

test("selected-vessel DELETE route persists the deletion", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-delete-test-"));
  const databasePath = path.join(tempDir, "vessels.json");
  fs.writeFileSync(
    databasePath,
    `${JSON.stringify({
      version: 1,
      plugin: "signalk-ajrm-marine-vessel-database",
      vessels: {
        232035943: {
          mmsi: "232035943",
          fields: { name: "EVE" },
          fieldUpdatedAt: {},
        },
      },
    })}\n`,
  );
  const app = fakeApp();
  const plugin = createPlugin(app);
  plugin.start({ databaseDirectory: tempDir, publishSummary: false });
  const routes = new Map();
  plugin.registerWithRouter({
    get() {},
    post() {},
    delete(route, handler) {
      routes.set(route, handler);
    },
  });
  const response = fakeResponse();

  routes.get("/vessels/:mmsi")({ params: { mmsi: "232035943" } }, response);
  plugin.stop();

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.deletedMmsi, "232035943");
  const saved = JSON.parse(fs.readFileSync(databasePath, "utf8"));
  assert.deepEqual(saved.vessels, {});
});

test("test cleanup deletes only Console BITE and Simulator's explicit identities", () => {
  const ordinaryMmsi = "232035943";
  const database = {
    updatedAt: "2026-08-01T00:00:00.000Z",
    vessels: {
      [ordinaryMmsi]: { mmsi: ordinaryMmsi, fields: { name: "EVE" } },
      [BITE_TEST_MMSIS[0]]: { mmsi: BITE_TEST_MMSIS[0], fields: { name: "BITE TEST TARGET" } },
      [BITE_TEST_MMSIS.at(-1)]: {
        mmsi: BITE_TEST_MMSIS.at(-1),
        fields: { name: "SIM AIS BASE EAST", aisClass: "BASE" },
      },
    },
  };

  assert.deepEqual(biteVesselMmsis(database), [BITE_TEST_MMSIS[0], BITE_TEST_MMSIS.at(-1)]);
  assert.deepEqual(
    removeBiteVesselRecords(database, "2026-08-03T15:00:00.000Z"),
    [BITE_TEST_MMSIS[0], BITE_TEST_MMSIS.at(-1)],
  );
  assert.deepEqual(Object.keys(database.vessels), [ordinaryMmsi]);
  assert.equal(database.updatedAt, "2026-08-03T15:00:00.000Z");
});

test("test cleanup contract contains current reserved Console and Simulator MMSIs", () => {
  assert.deepEqual(BITE_TEST_MMSIS, [
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
    "235900001",
    "235900002",
    "235900003",
    "235900004",
    "235900005",
    "235900006",
    "235900007",
    "235900008",
    "235900009",
    "235900010",
    "111000599",
    "002350001",
    "002350002",
  ]);
});

test("test cleanup includes both reserved Simulator AIS base stations", () => {
  const database = {
    updatedAt: "2026-08-01T00:00:00.000Z",
    vessels: {
      "002350001": {
        mmsi: "002350001",
        fields: { name: "SIM AIS BASE WEST", aisClass: "BASE" },
      },
      "002350002": {
        mmsi: "002350002",
        fields: { name: "SIM AIS BASE EAST", aisClass: "BASE" },
      },
      "002320768": {
        mmsi: "002320768",
        fields: { name: "REAL AIS BASE", aisClass: "BASE" },
      },
    },
  };

  assert.deepEqual(biteVesselMmsis(database), ["002350001", "002350002"]);
  assert.deepEqual(removeBiteVesselRecords(database), ["002350001", "002350002"]);
  assert.deepEqual(Object.keys(database.vessels), ["002320768"]);
});

function fakeApp() {
  return {
    signalk: new EventEmitter(),
    handleMessage() {},
    setPluginStatus() {},
    debug() {},
    error(error) {
      throw new Error(String(error));
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}
