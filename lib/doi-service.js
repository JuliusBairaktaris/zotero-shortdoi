/**
 * Pure DOI logic: validation, normalization, URL construction.
 *
 * No Zotero.* dependencies except Zotero.Utilities.cleanDOI for canonicalization.
 * Everything here is testable in isolation.
 */

const API_URLS = Object.freeze({
  SHORT_DOI: "https://shortdoi.org/",
  DOI_API: "https://doi.org/api/handles/",
  CROSSREF: "https://www.crossref.org/openurl?pid=zoteroDOI@wiernik.org&",
});

const SHORT_DOI_PATTERN = /10\/[^\s]*[^\s.,]/;

const SUPPORTED_ITEM_TYPES = Object.freeze([
  "journalArticle",
  "conferencePaper",
  "book",
  "bookSection",
  "report",
  "thesis",
  "preprint",
  "dataset",
  "document",
  "presentation",
  "standard",
  "encyclopediaArticle",
  "dictionaryEntry",
  "magazineArticle",
  "newspaperArticle",
]);

/**
 * @param {string} doi
 * @returns {boolean} true if the DOI is in shortDOI form (`10/xxxx`).
 */
function isShortDoi(doi) {
  return typeof doi === "string" && SHORT_DOI_PATTERN.test(doi);
}

/**
 * Build the lookup URL for a given DOI and operation.
 *
 * @param {string} rawDoi  Raw DOI from the item, may include prefixes/whitespace.
 * @param {"short"|"long"|"check"} operation
 * @returns {{kind: "lookup", url: string} | {kind: "invalid"}}
 *   `invalid` means the field has content but it isn't a valid DOI.
 *   Returns `null` if the field is empty (caller should fall back to CrossRef).
 */
function buildDoiLookupUrl(rawDoi, operation) {
  if (!rawDoi) return null;
  if (typeof rawDoi !== "string") return { kind: "invalid" };

  const cleaned = Zotero.Utilities.cleanDOI(rawDoi);
  if (!cleaned) return { kind: "invalid" };

  const url =
    operation === "short" && !isShortDoi(cleaned)
      ? `${API_URLS.SHORT_DOI}${encodeURIComponent(cleaned)}?format=json`
      : `${API_URLS.DOI_API}${encodeURIComponent(cleaned)}`;

  return { kind: "lookup", url };
}

/**
 * Build the CrossRef OpenURL lookup URL for an item lacking a DOI.
 *
 * @param {string} contextObject  Output of Zotero.OpenURL.createContextObject.
 * @returns {string}
 */
function buildCrossrefUrl(contextObject) {
  return `${API_URLS.CROSSREF}${contextObject}&multihit=true`;
}

/**
 * Build the user-facing CrossRef link URL stored on items with multiple DOIs.
 *
 * @param {string} contextObject
 * @returns {string}
 */
function buildCrossrefLinkUrl(contextObject) {
  return `${API_URLS.CROSSREF}${contextObject}`;
}

/**
 * Extract a shortDOI from the shortDOI API response.
 *
 * @param {object} response  JSON body returned by shortdoi.org.
 * @returns {string|null}
 */
function parseShortDoiResponse(response) {
  const value = (response.ShortDOI || response.handle || "").toLowerCase();
  return value || null;
}

/**
 * Extract the long DOI from a doi.org handle response.
 *
 * @param {object} response  JSON body from doi.org/api/handles.
 * @param {boolean} fromShortDoi  Whether the lookup originated from a shortDOI.
 * @returns {{ok: true, doi: string} | {ok: false, reason: "invalid" | "missing"}}
 */
function parseLongDoiResponse(response, fromShortDoi) {
  if (response.responseCode !== 1) {
    return { ok: false, reason: "invalid" };
  }

  const longDoi =
    fromShortDoi && response.values?.["1"]?.data?.value
      ? response.values["1"].data.value.toLowerCase()
      : (response.handle || "").toLowerCase();

  return longDoi
    ? { ok: true, doi: longDoi }
    : { ok: false, reason: "missing" };
}

/**
 * Interpret a doi.org check-DOI response against the existing DOI.
 *
 * @param {object} response
 * @param {string} existingDoi
 * @returns {{kind: "invalid"} | {kind: "unchanged"} | {kind: "updated", doi: string}}
 */
function parseCheckDoiResponse(response, existingDoi) {
  if (response.responseCode === 200) return { kind: "invalid" };
  if (!response.handle) return { kind: "invalid" };
  if (response.handle === existingDoi) return { kind: "unchanged" };
  return { kind: "updated", doi: response.handle.toLowerCase() };
}

/**
 * Extract the resolved DOI from a CrossRef OpenURL XML response.
 *
 * @param {Document} responseXml
 * @returns {{status: "resolved", doi: string} | {status: "unresolved" | "multiresolved" | "unknown"}}
 */
function parseCrossrefResponse(responseXml) {
  const query = responseXml.getElementsByTagName("query")[0];
  if (!query) return { status: "unknown" };

  const status = query.getAttribute("status");

  if (status === "resolved") {
    const doi = query.getElementsByTagName("doi")[0]?.childNodes[0]?.nodeValue;
    return doi ? { status: "resolved", doi } : { status: "unknown" };
  }

  if (status === "unresolved" || status === "multiresolved") {
    return { status };
  }

  return { status: "unknown" };
}

var DoiService = Object.freeze({
  API_URLS,
  SUPPORTED_ITEM_TYPES,
  isShortDoi,
  buildDoiLookupUrl,
  buildCrossrefUrl,
  buildCrossrefLinkUrl,
  parseShortDoiResponse,
  parseLongDoiResponse,
  parseCheckDoiResponse,
  parseCrossrefResponse,
});
