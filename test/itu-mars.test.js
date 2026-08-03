const assert = require("node:assert/strict");
const test = require("node:test");

const {
  explicitImo,
  lookupItuMarsByMmsi,
  parseDetailPage,
  parseSearchResult,
} = require("../plugin/itu-mars");

const SEARCH_PAGE = `
  <form><input name="Breadcrumb" type="hidden" value="search-token" /></form>
`;

const SEARCH_RESULT = `
  <form><input name="Breadcrumb" type="hidden" value="result-token" />
    <table><tbody><tr>
      <td><button name="onview" value="1422010">View</button></td>
      <td data-target="1422010">EVE</td>
      <td data-target="1422010">VSWE9</td>
      <td data-target="1422010">232035943</td>
      <td data-target="1422010">G</td>
      <td data-target="1422010">G</td>
      <td data-target="1422010"></td>
      <td data-target="1422010">21/06/2021</td>
    </tr></tbody></table>
  </form>
`;

const DETAIL_PAGE = `
  <div>Ship Name</div><label>EVE</label>
  <div>Call Sign</div><label>VSWE9</label>
  <div>MMSI</div><label>232035943</label>
  <div>Administration</div><label>United Kingdom of Great Britain and Northern Ireland (G)</label>
  <div>General Classification</div><label>PL</label>
  <div>Primary Individual Classification</div><label>YAT</label>
  <div>Gross Tonnage</div><label>7</label>
  <div>Capacity for persons</div><label>6</label>
  <div>Radio Installation</div><label>VHF FIXED</label>
`;

test("parses the exact MMSI row from ITU MARS search HTML", () => {
  const result = parseSearchResult(SEARCH_RESULT, "232035943");
  assert.deepEqual(result, {
    viewId: "1422010",
    name: "EVE",
    callsign: "VSWE9",
    mmsi: "232035943",
    administrationCode: "G",
    geographicalAreaCode: "G",
    vesselIdentificationNumber: "",
    recordUpdatedAt: "21/06/2021",
  });
  assert.equal(parseSearchResult(SEARCH_RESULT, "232000000"), null);
});

test("parses explicit ITU MARS detail labels without mapping classifications", () => {
  assert.deepEqual(parseDetailPage(DETAIL_PAGE), {
    name: "EVE",
    callsign: "VSWE9",
    mmsi: "232035943",
    administration: "United Kingdom of Great Britain and Northern Ireland (G)",
    geographicalArea: undefined,
    generalClassification: "PL",
    primaryClassification: "YAT",
    secondaryClassification: undefined,
    vesselIdentificationNumber: undefined,
    grossTonnage: "7",
    personCapacity: "6",
    radioInstallation: "VHF FIXED",
  });
});

test("only an explicitly labelled IMO value is imported as IMO", () => {
  assert.equal(explicitImo("IMO 9482902"), "9482902");
  assert.equal(explicitImo("9482902"), undefined);
  assert.equal(explicitImo("SSR12345"), undefined);
});

test("online lookup follows the ITU search and details form sequence", async () => {
  const requests = [];
  const pages = [SEARCH_PAGE, SEARCH_RESULT, DETAIL_PAGE];
  const fetchImpl = async (_url, options) => {
    requests.push(options);
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === "set-cookie" ? "session=test; Path=/" : null) },
      async text() {
        return pages.shift();
      },
    };
  };

  const result = await lookupItuMarsByMmsi("232035943", { fetchImpl });

  assert.equal(requests.length, 3);
  assert.match(requests[1].body, /Search\.MaritimeMobileServiceIdentity=232035943/);
  assert.match(requests[2].body, /onview=1422010/);
  assert.equal(result.name, "EVE");
  assert.equal(result.callsign, "VSWE9");
  assert.equal(result.detail.primaryClassification, "YAT");
  assert.equal(result.imo, undefined);
});
