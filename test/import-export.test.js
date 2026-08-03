const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildExportPayload,
  importDatabasePayload,
  lookupCandidates,
} = require("../plugin");

function databaseWithVessels() {
  return {
    version: 1,
    plugin: "signalk-ajrm-marine-vessel-database",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    vessels: {
      232035943: {
        mmsi: "232035943",
        firstSeen: "2026-08-01T10:00:00.000Z",
        lastSeen: "2026-08-01T11:00:00.000Z",
        updatedAt: "2026-08-01T11:00:00.000Z",
        fields: {
          name: "EVE",
          callsign: "VSWE9",
          length: 9.5,
          ituMars: { administration: "United Kingdom (G)", primaryClassification: "YAT" },
        },
        fieldUpdatedAt: { name: "2026-08-01T10:00:00.000Z" },
        onlineLookup: {
          status: "matched",
          source: "ITU MARS",
          sourceUrl: "https://www.itu.int/mmsapp/",
          checkedAt: "2026-08-01T11:00:00.000Z",
          matchedMmsi: "232035943",
        },
      },
      235900001: {
        mmsi: "235900001",
        firstSeen: "2026-08-01T10:00:00.000Z",
        lastSeen: "2026-08-01T11:00:00.000Z",
        updatedAt: "2026-08-01T11:00:00.000Z",
        fields: {},
        fieldUpdatedAt: {},
      },
    },
  };
}

test("exports a stable editable vessel array and restores it", () => {
  const source = databaseWithVessels();
  const exported = buildExportPayload(source);

  assert.equal(exported.format, "ajrm-marine-vessel-database");
  assert.deepEqual(
    exported.vessels.map((vessel) => vessel.mmsi),
    ["232035943", "235900001"],
  );
  assert.equal(exported.vessels[0].name, "EVE");
  assert.equal(exported.vessels[0].ituMars.primaryClassification, "YAT");

  const restored = importDatabasePayload({ vessels: {} }, exported, "replace");
  assert.equal(restored.summary.total, 2);
  assert.equal(restored.database.vessels["232035943"].fields.name, "EVE");
  assert.equal(
    restored.database.vessels["232035943"].onlineLookup.source,
    "ITU MARS",
  );
});

test("merge import applies edits, clears explicit nulls, and keeps unlisted vessels", () => {
  const source = databaseWithVessels();
  const imported = importDatabasePayload(
    source,
    {
      format: "ajrm-marine-vessel-database",
      vessels: [
        {
          mmsi: "232035943",
          name: "EVE OF TAYVALLICH",
          callsign: null,
          beam: 3.2,
        },
      ],
    },
    "merge",
  );

  const eve = imported.database.vessels["232035943"];
  assert.equal(eve.fields.name, "EVE OF TAYVALLICH");
  assert.equal(eve.fields.callsign, undefined);
  assert.equal(eve.fields.length, 9.5);
  assert.equal(eve.fields.beam, 3.2);
  assert.ok(imported.database.vessels["235900001"]);
});

test("replace import removes vessels omitted from the imported backup", () => {
  const imported = importDatabasePayload(
    databaseWithVessels(),
    { vessels: [{ mmsi: "232035943", name: "EVE" }] },
    "replace",
  );

  assert.deepEqual(Object.keys(imported.database.vessels), ["232035943"]);
});

test("import rejects duplicate MMSIs and unknown editable field names", () => {
  assert.throws(
    () =>
      importDatabasePayload(
        { vessels: {} },
        { vessels: [{ mmsi: "232035943" }, { mmsi: "232035943" }] },
        "merge",
      ),
    /Duplicate MMSI/,
  );
  assert.throws(
    () =>
      importDatabasePayload(
        { vessels: {} },
        { vessels: [{ mmsi: "232035943", vesselNmae: "Typo" }] },
        "merge",
      ),
    /unknown field: vesselNmae/,
  );
});

test("online lookup selects vessels missing a name or callsign", () => {
  const database = databaseWithVessels();
  database.vessels["235900002"] = {
    mmsi: "235900002",
    fields: { name: "COMPLETE", callsign: "VSC002" },
  };

  assert.deepEqual(lookupCandidates(database), ["235900001"]);
});

test("online ship lookup excludes ITU SAR aircraft", () => {
  const database = {
    vessels: {
      "111232534": { mmsi: "111232534", fields: {} },
      "235900001": { mmsi: "235900001", fields: {} },
    },
  };

  assert.deepEqual(lookupCandidates(database), ["235900001"]);
});
