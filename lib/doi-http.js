/**
 * HTTP fetchers for DOI resolution APIs.
 *
 * Wraps Zotero.HTTP.request and normalizes results so the update loop
 * never has to think about XHR status codes or exception types.
 */

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Issue an HTTP GET via Zotero.HTTP.request and return either the response
 * object or a status describing the failure mode.
 *
 * 400 and 404 are returned as `{ status: "invalid" }` because every API this
 * plugin talks to (shortdoi.org, doi.org, CrossRef) treats those as "not a
 * valid identifier" rather than a transport error.
 *
 * @param {string} url
 * @param {"json" | "document"} responseType
 * @returns {Promise<{status: "ok", response: any}
 *               | {status: "invalid"}
 *               | {status: "error", error: Error}>}
 */
async function fetchJsonOrDoc(url, responseType) {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType,
      timeout: REQUEST_TIMEOUT_MS,
      successCodes: [200],
    });
    const response = responseType === "json" ? xhr.response : xhr.responseXML;
    return { status: "ok", response };
  } catch (error) {
    if (error instanceof Zotero.HTTP.UnexpectedStatusException) {
      const code = error.xmlhttp?.status;
      if (code === 400 || code === 404) {
        return { status: "invalid" };
      }
    }
    return { status: "error", error };
  }
}

/**
 * Look up a DOI handle (long form lookup or shortDOI lookup).
 *
 * @param {string} url
 * @returns {Promise<{status: "ok", response: object}
 *               | {status: "invalid"}
 *               | {status: "error", error: Error}>}
 */
function fetchDoiHandle(url) {
  return fetchJsonOrDoc(url, "json");
}

/**
 * Look up an item by metadata via the CrossRef OpenURL endpoint.
 *
 * @param {string} url
 * @returns {Promise<{status: "ok", response: Document}
 *               | {status: "invalid"}
 *               | {status: "error", error: Error}>}
 */
function fetchCrossref(url) {
  return fetchJsonOrDoc(url, "document");
}

var DoiHttp = Object.freeze({
  fetchDoiHandle,
  fetchCrossref,
});
