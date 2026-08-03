const API_BASE = "/plugins/signalk-ajrm-marine-vessel-database";

const els = {
  summary: document.getElementById("summary"),
  status: document.getElementById("status"),
  filter: document.getElementById("filter"),
  refresh: document.getElementById("refresh"),
  exportVessels: document.getElementById("exportVessels"),
  importVessels: document.getElementById("importVessels"),
  importFile: document.getElementById("importFile"),
  importDialog: document.getElementById("importDialog"),
  importFileSummary: document.getElementById("importFileSummary"),
  importMerge: document.getElementById("importMerge"),
  importReplace: document.getElementById("importReplace"),
  lookupUnknown: document.getElementById("lookupUnknown"),
  cancelLookup: document.getElementById("cancelLookup"),
  deleteBite: document.getElementById("deleteBite"),
  deleteAll: document.getElementById("deleteAll"),
  vessels: document.getElementById("vessels"),
  details: document.getElementById("details"),
  detailsName: document.getElementById("detailsName"),
  detailsSubtitle: document.getElementById("detailsSubtitle"),
  detailsList: document.getElementById("detailsList"),
  deleteVessel: document.getElementById("deleteVessel"),
  closeDetails: document.getElementById("closeDetails"),
};

let vessels = [];
let selectedMmsi = "";
let visibleVessels = [];
let pendingImport = null;
let lookupPollTimer = null;
let biteVesselCount = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    let message = `Request failed with HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // Keep the HTTP message.
    }
    throw new Error(message);
  }
  return response.json();
}

function formatDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(Math.abs(number) >= 10 ? 0 : 1)} m` : "";
}

function formatTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleString();
}

function typeName(shipType) {
  if (!shipType) return "";
  if (typeof shipType === "string") return shipType;
  return shipType.name || shipType.id || "";
}

function valueText(value) {
  return value === undefined || value === null || value === "" ? "Not known" : String(value);
}

function matchesFilter(vessel, query) {
  if (!query) return true;
  const haystack = [
    vessel.name,
    vessel.mmsi,
    vessel.callsign,
    vessel.imo,
    vessel.aisClass,
    vessel.categoryLabel,
    typeName(vessel.shipType),
    vessel.ituMars?.administration,
    vessel.ituMars?.generalClassification,
    vessel.ituMars?.primaryClassification,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function render() {
  const query = els.filter.value.trim();
  visibleVessels = vessels.filter((vessel) => matchesFilter(vessel, query));
  els.summary.textContent = `${visibleVessels.length} of ${vessels.length} vessels`;

  if (!visibleVessels.length) {
    els.vessels.innerHTML = `<tr><td colspan="9" class="empty">No vessels found</td></tr>`;
    if (selectedMmsi) renderDetails(null);
    return;
  }

  if (selectedMmsi && !visibleVessels.some((vessel) => String(vessel.mmsi || "") === selectedMmsi)) {
    renderDetails(null);
  }

  els.vessels.innerHTML = visibleVessels
    .map(
      (vessel) => `<tr data-mmsi="${escapeHtml(vessel.mmsi || "")}" tabindex="0">
        <td>${escapeHtml(vessel.name || "")}</td>
        <td class="mono">${escapeHtml(vessel.mmsi || "")}</td>
        <td>${escapeHtml(vessel.categoryLabel || "Vessel / surface craft")}</td>
        <td>${escapeHtml(vessel.callsign || "")}</td>
        <td>${escapeHtml(typeName(vessel.shipType))}</td>
        <td>${escapeHtml(vessel.aisClass || "")}</td>
        <td>${escapeHtml(formatDimension(vessel.length))}</td>
        <td>${escapeHtml(formatDimension(vessel.beam))}</td>
        <td>${escapeHtml(formatTime(vessel.lastSeen))}</td>
      </tr>`,
    )
    .join("");
  updateSelectedRow();
}

function renderDetails(vessel) {
  if (!vessel) {
    selectedMmsi = "";
    els.details.hidden = true;
    updateSelectedRow();
    return;
  }

  selectedMmsi = String(vessel.mmsi || "");
  els.details.hidden = false;
  els.detailsName.textContent = vessel.name || "Unknown vessel";
  els.detailsSubtitle.textContent = selectedMmsi ? `MMSI ${selectedMmsi}` : "No MMSI";
  const rows = [
    ["Name", vessel.name],
    ["MMSI", vessel.mmsi],
    ["Category", vessel.categoryLabel],
    ["Collision candidate", vessel.collisionCandidate === false ? "No" : "Yes"],
    ["Callsign", vessel.callsign],
    ["IMO", vessel.imo],
    ["Type", typeName(vessel.shipType)],
    ["AIS class", vessel.aisClass],
    ["Length", formatDimension(vessel.length)],
    ["Beam", formatDimension(vessel.beam)],
    ["GPS antenna from bow", formatDimension(vessel.aisFromBow)],
    ["GPS antenna from centre", formatDimension(vessel.aisFromCenter)],
    ["ITU MARS administration", vessel.ituMars?.administration],
    ["ITU MARS geographical area", vessel.ituMars?.geographicalArea],
    ["ITU MARS general classification", vessel.ituMars?.generalClassification],
    ["ITU MARS primary classification", vessel.ituMars?.primaryClassification],
    ["ITU MARS secondary classification", vessel.ituMars?.secondaryClassification],
    ["ITU MARS vessel ID", vessel.ituMars?.vesselIdentificationNumber],
    ["ITU MARS gross tonnage", vessel.ituMars?.grossTonnage],
    ["ITU MARS person capacity", vessel.ituMars?.personCapacity],
    ["ITU MARS radio installation", vessel.ituMars?.radioInstallation],
    ["Online lookup", vessel.onlineLookup?.status],
    ["Online lookup checked", formatTime(vessel.onlineLookup?.checkedAt)],
    ["Last seen", formatTime(vessel.lastSeen)],
    ["Updated", formatTime(vessel.updatedAt)],
  ];

  els.detailsList.innerHTML = rows
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(valueText(value))}</dd></div>`,
    )
    .join("");
  updateSelectedRow();
}

function updateSelectedRow() {
  els.vessels.querySelectorAll("tr[data-mmsi]").forEach((row) => {
    row.classList.toggle("selected", row.dataset.mmsi === selectedMmsi);
  });
}

function selectVesselByMmsi(mmsi, focusRow = false) {
  const vessel = vessels.find((item) => String(item.mmsi || "") === String(mmsi || ""));
  renderDetails(vessel);
  if (focusRow) focusSelectedRow();
}

function focusSelectedRow() {
  if (!selectedMmsi) return;
  const row = [...els.vessels.querySelectorAll("tr[data-mmsi]")].find(
    (item) => item.dataset.mmsi === selectedMmsi,
  );
  if (!row) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

function moveSelection(direction) {
  if (!visibleVessels.length) return;
  const currentIndex = visibleVessels.findIndex(
    (vessel) => String(vessel.mmsi || "") === selectedMmsi,
  );
  const fallbackIndex = direction > 0 ? 0 : visibleVessels.length - 1;
  const nextIndex =
    currentIndex < 0
      ? fallbackIndex
      : Math.min(visibleVessels.length - 1, Math.max(0, currentIndex + direction));
  selectVesselByMmsi(visibleVessels[nextIndex]?.mmsi, true);
}

async function refresh() {
  els.status.textContent = "Loading vessel database";
  const data = await requestJson(`${API_BASE}/vessels`);
  vessels = Array.isArray(data.vessels) ? data.vessels : [];
  biteVesselCount = Number(data.status?.biteVesselCount) || 0;
  els.deleteBite.disabled = biteVesselCount === 0 || data.status?.lookup?.running === true;
  if (selectedMmsi && !vessels.some((vessel) => String(vessel.mmsi || "") === selectedMmsi)) {
    renderDetails(null);
  }
  render();
  const file = data.status?.databasePath ? `, stored at ${data.status.databasePath}` : "";
  els.status.textContent = `Updated ${new Date().toLocaleTimeString()}${file}`;
}

async function deleteAll() {
  const confirmed = window.confirm(
    "Delete every learned vessel from AJRM Marine Vessel Database? This is useful for clearing debug data.",
  );
  if (!confirmed) return;
  els.status.textContent = "Deleting vessel database";
  await requestJson(`${API_BASE}/delete-all`, { method: "POST" });
  vessels = [];
  renderDetails(null);
  render();
  els.status.textContent = "Vessel database cleared";
}

async function deleteSelectedVessel() {
  const vessel = vessels.find((item) => String(item.mmsi || "") === selectedMmsi);
  if (!vessel?.mmsi) return;
  const identity = vessel.name ? `${vessel.name} (MMSI ${vessel.mmsi})` : `MMSI ${vessel.mmsi}`;
  if (
    !window.confirm(
      `Delete ${identity} from AJRM Marine Vessel Database? It may be learned again if future AIS data supplies its details.`,
    )
  ) {
    return;
  }
  els.deleteVessel.disabled = true;
  els.status.textContent = `Deleting ${identity}`;
  try {
    await requestJson(`${API_BASE}/vessels/${encodeURIComponent(vessel.mmsi)}`, {
      method: "DELETE",
    });
    renderDetails(null);
    await refresh();
    els.status.textContent = `Deleted ${identity}`;
  } finally {
    els.deleteVessel.disabled = false;
  }
}

async function deleteBiteVessels() {
  if (!biteVesselCount) {
    els.status.textContent = "No stored BITE test vessels to delete";
    return;
  }
  if (
    !window.confirm(
      `Delete ${biteVesselCount} stored AJRM Marine Console BITE test vessels? Ordinary vessels will not be affected.`,
    )
  ) {
    return;
  }
  els.deleteBite.disabled = true;
  els.status.textContent = `Deleting ${biteVesselCount} BITE test vessels`;
  const result = await requestJson(`${API_BASE}/delete-bite`, { method: "POST" });
  renderDetails(null);
  await refresh();
  els.status.textContent = `Deleted ${result.removedCount} BITE test vessels`;
}

function exportVessels() {
  const link = document.createElement("a");
  link.href = `${API_BASE}/export`;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
  els.status.textContent = "Vessel database export requested";
}

async function chooseImportFile(file) {
  if (!file) return;
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!payload || !Array.isArray(payload.vessels)) {
    throw new Error("The selected JSON file does not contain a vessels array");
  }
  pendingImport = payload;
  els.importFileSummary.textContent = `${file.name}: ${payload.vessels.length} vessel records.`;
  if (typeof els.importDialog.showModal === "function") els.importDialog.showModal();
  else await importVesselPayload("merge");
}

async function importVesselPayload(mode) {
  if (!pendingImport) return;
  if (
    mode === "replace" &&
    !window.confirm(
      "Replace the entire vessel database with this file? A server-side pre-import backup will be written first.",
    )
  ) {
    return;
  }
  els.importMerge.disabled = true;
  els.importReplace.disabled = true;
  els.status.textContent = `Importing vessel database (${mode})`;
  try {
    const result = await requestJson(`${API_BASE}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, payload: pendingImport }),
    });
    pendingImport = null;
    els.importDialog.close();
    await refresh();
    els.status.textContent = `Imported ${result.imported} vessels (${mode}); ${result.added} added and ${result.updated} updated`;
  } finally {
    els.importMerge.disabled = false;
    els.importReplace.disabled = false;
    els.importFile.value = "";
  }
}

function unknownVesselCount() {
  return vessels.filter(
    (vessel) =>
      vessel.onlineShipLookupEligible !== false &&
      (!String(vessel.name || "").trim() || !String(vessel.callsign || "").trim()),
  )
    .length;
}

async function startLookup() {
  const count = unknownVesselCount();
  if (!count) {
    els.status.textContent = "Every vessel already has a name and callsign";
    return;
  }
  if (
    !window.confirm(
      `Look up ${count} vessels with a missing name or callsign in the official ITU MARS register? Existing values will not be overwritten.`,
    )
  ) {
    return;
  }
  const result = await requestJson(`${API_BASE}/lookup/start`, { method: "POST" });
  renderLookupStatus(result.lookup);
  scheduleLookupPoll();
}

async function cancelLookup() {
  const result = await requestJson(`${API_BASE}/lookup/cancel`, { method: "POST" });
  renderLookupStatus(result.lookup);
}

function renderLookupStatus(lookup) {
  const running = lookup?.running === true;
  els.lookupUnknown.disabled = running;
  els.importVessels.disabled = running;
  els.deleteAll.disabled = running;
  els.deleteVessel.disabled = running;
  els.deleteBite.disabled = running || biteVesselCount === 0;
  els.cancelLookup.hidden = !running;
  if (running) {
    const current = lookup.currentMmsi ? `, MMSI ${lookup.currentMmsi}` : "";
    els.status.textContent = `ITU MARS lookup ${lookup.processed}/${lookup.total}${current}; ${lookup.updated} updated, ${lookup.notFound} not found, ${lookup.failed} failed`;
    return;
  }
  if (lookup?.finishedAt) {
    const state = lookup.cancelled ? "cancelled" : "finished";
    els.status.textContent = `ITU MARS lookup ${state}: ${lookup.updated} updated, ${lookup.notFound} not found, ${lookup.failed} failed`;
  }
}

function scheduleLookupPoll() {
  if (lookupPollTimer) clearTimeout(lookupPollTimer);
  lookupPollTimer = setTimeout(() => {
    pollLookup().catch(showError);
  }, 1_000);
}

async function pollLookup() {
  const result = await requestJson(`${API_BASE}/lookup/status`);
  renderLookupStatus(result.lookup);
  if (result.lookup?.running) scheduleLookupPoll();
  else {
    await refresh();
    renderLookupStatus(result.lookup);
  }
}

els.refresh.addEventListener("click", () => {
  refresh().catch(showError);
});

els.deleteAll.addEventListener("click", () => {
  deleteAll().catch(showError);
});

els.deleteVessel.addEventListener("click", () => {
  deleteSelectedVessel().catch(showError);
});

els.deleteBite.addEventListener("click", () => {
  deleteBiteVessels().catch(showError);
});

els.exportVessels.addEventListener("click", exportVessels);

els.importVessels.addEventListener("click", () => els.importFile.click());

els.importFile.addEventListener("change", () => {
  chooseImportFile(els.importFile.files?.[0]).catch(showError);
});

els.importMerge.addEventListener("click", () => {
  importVesselPayload("merge").catch(showError);
});

els.importReplace.addEventListener("click", () => {
  importVesselPayload("replace").catch(showError);
});

els.lookupUnknown.addEventListener("click", () => {
  startLookup().catch(showError);
});

els.cancelLookup.addEventListener("click", () => {
  cancelLookup().catch(showError);
});

els.filter.addEventListener("input", render);

els.closeDetails.addEventListener("click", () => renderDetails(null));

els.vessels.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-mmsi]");
  if (row) selectVesselByMmsi(row.dataset.mmsi, true);
});

els.vessels.addEventListener("keydown", (event) => {
  const row = event.target.closest("tr[data-mmsi]");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  if (row) {
    event.preventDefault();
    selectVesselByMmsi(row.dataset.mmsi);
  }
});

function showError(error) {
  console.error(error);
  els.status.textContent = `Problem: ${error.message}`;
}

Promise.all([refresh(), requestJson(`${API_BASE}/lookup/status`)]).then(([, result]) => {
  renderLookupStatus(result.lookup);
  if (result.lookup?.running) scheduleLookupPoll();
}).catch(showError);
