/**
 * Implements the itu mars responsibilities of the AJRM Marine Vessel Database Signal K server.
 */

const ITU_MARS_URL = "https://www.itu.int/mmsapp/";
const DEFAULT_TIMEOUT_MS = 20_000;

async function lookupItuMarsByMmsi(mmsi, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Online lookup requires a Node.js fetch implementation");
  }

  const normalizedMmsi = normalizeMmsi(mmsi);
  if (!normalizedMmsi) throw new Error("A valid nine-digit MMSI is required");

  const commonHeaders = {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent":
      "AJRM-Marine-Vessel-Database/online-lookup (+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-vessel-database)",
  };
  const searchPage = await fetchText(fetchImpl, ITU_MARS_URL, {
    headers: commonHeaders,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  const breadcrumb = hiddenInputValue(searchPage.text, "Breadcrumb");
  if (!breadcrumb) throw new Error("ITU MARS search token was not available");
  const cookie = responseCookies(searchPage.response);

  const searchBody = new URLSearchParams({
    Breadcrumb: breadcrumb,
    "Search.MaritimeMobileServiceIdentity": normalizedMmsi,
    viewCommand: "Search",
  });
  const searchResult = await fetchText(fetchImpl, ITU_MARS_URL, {
    method: "POST",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: searchBody.toString(),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  const match = parseSearchResult(searchResult.text, normalizedMmsi);
  if (!match) return null;

  const resultBreadcrumb = hiddenInputValue(searchResult.text, "Breadcrumb");
  if (!resultBreadcrumb || !match.viewId) return normalizeLookupResult(match, normalizedMmsi);
  const detailCookie = mergeCookies(cookie, responseCookies(searchResult.response));
  const detailBody = new URLSearchParams({
    Breadcrumb: resultBreadcrumb,
    onview: match.viewId,
  });
  const detailResult = await fetchText(fetchImpl, ITU_MARS_URL, {
    method: "POST",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(detailCookie ? { Cookie: detailCookie } : {}),
    },
    body: detailBody.toString(),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  return normalizeLookupResult(
    { ...match, ...parseDetailPage(detailResult.text) },
    normalizedMmsi,
  );
}

async function fetchText(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`ITU MARS returned HTTP ${response?.status || "unknown"}`);
    }
    return { response, text: await response.text() };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(options.signal?.aborted ? "ITU MARS lookup cancelled" : "ITU MARS lookup timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseSearchResult(html, mmsi) {
  for (const rowMatch of String(html || "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    const viewId = row.match(/name=["']onview["'][^>]*value=["']([^"']+)["']/i)?.[1];
    if (!viewId) continue;
    const cells = [...row.matchAll(/<td[^>]*data-target=["'][^"']+["'][^>]*>([\s\S]*?)<\/td>/gi)].map(
      (item) => cleanHtmlText(item[1]),
    );
    if (cells[2] !== mmsi) continue;
    return {
      viewId,
      name: cells[0],
      callsign: cells[1],
      mmsi: cells[2],
      administrationCode: cells[3],
      geographicalAreaCode: cells[4],
      vesselIdentificationNumber: cells[5],
      recordUpdatedAt: cells[6],
    };
  }
  return null;
}

function parseDetailPage(html) {
  const labels = {};
  const pattern = /<div[^>]*>\s*([^<]+?)\s*<\/div>\s*<label[^>]*>([\s\S]*?)<\/label>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    labels[cleanHtmlText(match[1])] = cleanHtmlText(match[2]);
  }
  return {
    name: labels["Ship Name"],
    callsign: labels["Call Sign"],
    mmsi: labels.MMSI,
    administration: labels.Administration,
    geographicalArea: labels["Geographical Area"],
    generalClassification: labels["General Classification"],
    primaryClassification: labels["Primary Individual Classification"],
    secondaryClassification: labels["Secondary Individual Classification"],
    vesselIdentificationNumber: labels["Ship (Vessel) Identification Number"],
    grossTonnage: labels["Gross Tonnage"],
    personCapacity: labels["Capacity for persons"],
    radioInstallation: labels["Radio Installation"],
  };
}

function normalizeLookupResult(result, mmsi) {
  if (normalizeMmsi(result?.mmsi) !== mmsi) return null;
  const detail = compactObject({
    administration: cleanValue(result.administration),
    administrationCode: cleanValue(result.administrationCode),
    geographicalArea: cleanValue(result.geographicalArea),
    geographicalAreaCode: cleanValue(result.geographicalAreaCode),
    generalClassification: cleanValue(result.generalClassification),
    primaryClassification: cleanValue(result.primaryClassification),
    secondaryClassification: cleanValue(result.secondaryClassification),
    vesselIdentificationNumber: cleanValue(result.vesselIdentificationNumber),
    grossTonnage: cleanValue(result.grossTonnage),
    personCapacity: cleanValue(result.personCapacity),
    radioInstallation: cleanValue(result.radioInstallation),
    recordUpdatedAt: cleanValue(result.recordUpdatedAt),
  });
  return {
    source: "ITU MARS",
    sourceUrl: ITU_MARS_URL,
    mmsi,
    name: cleanValue(result.name),
    callsign: cleanValue(result.callsign),
    imo: explicitImo(result.vesselIdentificationNumber),
    detail,
  };
}

function hiddenInputValue(html, name) {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `<input[^>]*name=["']${escaped}["'][^>]*value=["']([^"']*)["'][^>]*>`,
    "i",
  );
  return decodeHtml(pattern.exec(String(html || ""))?.[1] || "");
}

function responseCookies(response) {
  const headers = response?.headers;
  const values = typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : [];
  const raw = values.length ? values : [headers?.get?.("set-cookie")].filter(Boolean);
  return raw
    .flatMap((value) => String(value).split(/,(?=\s*[^;,=]+=[^;,]+)/))
    .map((value) => value.split(";", 1)[0].trim())
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(...cookies) {
  const entries = new Map();
  for (const cookie of cookies) {
    for (const pair of String(cookie || "").split(/;\s*/)) {
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      entries.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  return [...entries].map(([key, value]) => `${key}=${value}`).join("; ");
}

function cleanHtmlText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function explicitImo(value) {
  const match = String(value || "").trim().match(/^IMO\s*([0-9]{7})$/i);
  return match?.[1];
}

function normalizeMmsi(value) {
  const text = String(value || "").trim();
  return /^\d{9}$/.test(text) ? text : undefined;
}

function cleanValue(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  ITU_MARS_URL,
  explicitImo,
  hiddenInputValue,
  lookupItuMarsByMmsi,
  normalizeLookupResult,
  parseDetailPage,
  parseSearchResult,
};
