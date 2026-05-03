/**
 * Async update loop. Replaces the previous callback-based state machine.
 *
 * `updateItems(items, operation)` is the only entry point. It runs a single
 * sequential pass over the supported items, dispatches each through the
 * DOI APIs, applies the result to the item, and reports progress.
 *
 * Re-entrancy is prevented by an `isRunning` flag rather than by inspecting
 * mutable counters, so the auto-retrieve notifier won't kick off a parallel
 * pass while a manual one is in flight.
 */

const ICONS = Object.freeze({
  ERROR: "chrome://zotero/skin/cross.png",
  SUCCESS: "chrome://zotero/skin/tick.png",
});

const PROGRESS_HEADLINES = Object.freeze({
  short: "Getting shortDOIs",
  long: "Getting long DOIs",
  check: "Validating DOIs and removing extra text",
});

const COMPLETION_MESSAGES = Object.freeze({
  short: (n) => `shortDOIs updated for ${n} items.`,
  long: (n) => `Long DOIs updated for ${n} items.`,
  check: (n) => `DOIs verified for ${n} items.`,
});

const ERROR_MESSAGES = Object.freeze({
  invalid: {
    headline: "Invalid DOI",
    plain: "Invalid DOIs were found.",
    tagged: (tag) => `Invalid DOIs were found. These have been tagged with '${tag}'.`,
  },
  nodoi: {
    headline: "DOI not found",
    plain: "No DOI was found for some items.",
    tagged: (tag) => `No DOI was found for some items. These have been tagged with '${tag}'.`,
  },
  multiple: {
    headline: "Multiple possible DOIs",
    plain: "Some items had multiple possible DOIs.",
    tagged: (tag) =>
      `Some items had multiple possible DOIs. Links to lists of DOIs have been added and tagged with '${tag}'.`,
  },
});

let isRunning = false;

/**
 * Read all DOI-related preferences once per run.
 *
 * @returns {{tagInvalid: string, tagNodoi: string, tagMultiple: string, autoretrieve: string}}
 */
function readPrefs() {
  const get = (key) => Zotero.Prefs.get(`extensions.shortdoi.${key}`, true);
  return {
    tagInvalid: get("tag_invalid"),
    tagNodoi: get("tag_nodoi"),
    tagMultiple: get("tag_multiple"),
    autoretrieve: get("autoretrieve"),
  };
}

function removeAllDoiTags(item, prefs) {
  item.removeTag(prefs.tagInvalid);
  item.removeTag(prefs.tagMultiple);
  item.removeTag(prefs.tagNodoi);
}

function hasAnyDoiTag(item, prefs) {
  return (
    item.hasTag(prefs.tagInvalid) ||
    item.hasTag(prefs.tagMultiple) ||
    item.hasTag(prefs.tagNodoi)
  );
}

/**
 * Filter the input set to items whose type the plugin supports.
 *
 * @returns {{ supported: Zotero.Item[], unsupported: Zotero.Item[] }}
 */
function partitionItems(items) {
  const supportedTypeIDs = new Set(
    DoiService.SUPPORTED_ITEM_TYPES
      .map((type) => Zotero.ItemTypes.getID(type))
      .filter((id) => id !== false)
  );

  const supported = [];
  const unsupported = [];

  for (const item of items) {
    if (!item.isRegularItem() || item.isFeedItem) continue;
    if (supportedTypeIDs.has(item.itemTypeID)) {
      supported.push(item);
    } else {
      unsupported.push(item);
    }
  }

  return { supported, unsupported };
}

function showUnsupportedWarning(unsupportedItems) {
  const types = [
    ...new Set(
      unsupportedItems.map((item) => Zotero.ItemTypes.getName(item.itemTypeID))
    ),
  ];

  const window = new Zotero.ProgressWindow({ closeOnClick: true });
  window.changeHeadline("Unsupported Item Types");
  window.progress = new window.ItemProgress(
    ICONS.ERROR,
    `${unsupportedItems.length} item(s) skipped (unsupported types: ${types.join(", ")})`
  );
  window.progress.setError();
  window.show();
  window.startCloseTimer(6000);
}

function openProgressWindow(operation, rootURI) {
  const window = new Zotero.ProgressWindow({ closeOnClick: true });
  const headlineIcon = `chrome://zotero/skin/toolbar-advanced-search${Zotero.hiDPI ? "@2x" : ""}.png`;
  window.changeHeadline(PROGRESS_HEADLINES[operation] ?? PROGRESS_HEADLINES.check, headlineIcon);

  const doiIcon = `${rootURI}skin/doi${Zotero.hiDPI ? "@2x" : ""}.png`;
  window.progress = new window.ItemProgress(doiIcon, "Checking DOIs.");
  window.show();
  return window;
}

function updateProgress(window, current, total) {
  const percent = Math.round((current / total) * 100);
  window.progress.setProgress(percent);
  window.progress.setText(`Item ${current} of ${total}`);
}

function showCompletion(progressWindow, operation, results, prefs) {
  const errorBuckets = ["invalid", "nodoi", "multiple"];
  const hasErrors = errorBuckets.some((bucket) => results.counts[bucket] > 0);

  if (progressWindow) progressWindow.close();

  if (hasErrors) {
    showErrorWindows(results.counts, prefs);
    return;
  }

  const successWindow = new Zotero.ProgressWindow({ closeOnClick: true });
  successWindow.changeHeadline("Finished");
  successWindow.progress = new successWindow.ItemProgress(ICONS.SUCCESS, "");
  successWindow.progress.setProgress(100);
  const message = (COMPLETION_MESSAGES[operation] ?? COMPLETION_MESSAGES.check)(results.counts.updated);
  successWindow.progress.setText(message);
  successWindow.show();
  successWindow.startCloseTimer(4000);
}

function showErrorWindows(counts, prefs) {
  const tagFor = { invalid: prefs.tagInvalid, nodoi: prefs.tagNodoi, multiple: prefs.tagMultiple };

  for (const bucket of ["invalid", "nodoi", "multiple"]) {
    if (counts[bucket] === 0) continue;

    const config = ERROR_MESSAGES[bucket];
    const tag = tagFor[bucket];
    const message = tag ? config.tagged(tag) : config.plain;

    const window = new Zotero.ProgressWindow({ closeOnClick: true });
    window.changeHeadline(config.headline);
    window.progress = new window.ItemProgress(ICONS.ERROR, message);
    window.progress.setError();
    window.show();
    window.startCloseTimer(8000);
  }
}

/**
 * Mark an item as having an invalid DOI, and tag it if the preference is set.
 */
async function markInvalid(item, prefs) {
  if (!item.isRegularItem()) return;
  if (prefs.tagInvalid) item.addTag(prefs.tagInvalid, 1);
  await item.saveTx();
}

/**
 * Process a single item for a single operation.
 *
 * @returns {Promise<"updated" | "invalid" | "nodoi" | "multiple" | "skipped">}
 */
async function processItem(item, operation, prefs) {
  const existingDoi = item.getField("DOI");

  if (!existingDoi) {
    return processCrossrefLookup(item, operation, prefs);
  }

  const target = DoiService.buildDoiLookupUrl(existingDoi, operation);
  if (target?.kind === "invalid") {
    await markInvalid(item, prefs);
    return "invalid";
  }
  if (!target) {
    if (item.hasTag(prefs.tagInvalid)) {
      item.removeTag(prefs.tagInvalid);
      await item.saveTx();
    }
    return "skipped";
  }

  const result = await DoiHttp.fetchDoiHandle(target.url);

  if (result.status === "invalid") {
    await markInvalid(item, prefs);
    return "invalid";
  }

  if (result.status === "error") {
    Zotero.debug(`DOI Manager: HTTP error fetching DOI: ${result.error}`);
    return "skipped";
  }

  return applyDoiResponse(result.response, item, existingDoi, operation, prefs);
}

async function applyDoiResponse(response, item, existingDoi, operation, prefs) {
  if (!item.isRegularItem()) return "skipped";

  switch (operation) {
    case "short": {
      const shortDoi = DoiService.parseShortDoiResponse(response);
      if (!shortDoi) {
        await markInvalid(item, prefs);
        return "invalid";
      }
      item.setField("DOI", shortDoi);
      removeAllDoiTags(item, prefs);
      await item.saveTx();
      return "updated";
    }

    case "long": {
      const parsed = DoiService.parseLongDoiResponse(
        response,
        DoiService.isShortDoi(existingDoi)
      );
      if (!parsed.ok) {
        await markInvalid(item, prefs);
        return "invalid";
      }
      item.setField("DOI", parsed.doi);
      removeAllDoiTags(item, prefs);
      await item.saveTx();
      return "updated";
    }

    case "check":
    default: {
      const parsed = DoiService.parseCheckDoiResponse(response, existingDoi);
      if (parsed.kind === "invalid") {
        await markInvalid(item, prefs);
        return "invalid";
      }
      if (parsed.kind === "updated") {
        item.setField("DOI", parsed.doi);
        removeAllDoiTags(item, prefs);
        await item.saveTx();
      } else if (hasAnyDoiTag(item, prefs)) {
        removeAllDoiTags(item, prefs);
        await item.saveTx();
      }
      return "updated";
    }
  }
}

/**
 * Item has no DOI: try CrossRef. On a single resolved hit, apply the DOI
 * (and recurse for the "short" operation to convert it to shortDOI form).
 */
async function processCrossrefLookup(item, operation, prefs) {
  const ctx = Zotero.OpenURL.createContextObject(item, "1.0");
  if (!ctx) return "skipped";

  const result = await DoiHttp.fetchCrossref(DoiService.buildCrossrefUrl(ctx));

  if (result.status === "error") {
    Zotero.debug(`DOI Manager: CrossRef lookup failed: ${result.error}`);
    return "skipped";
  }
  if (result.status === "invalid") {
    return "skipped";
  }

  const parsed = DoiService.parseCrossrefResponse(result.response);

  switch (parsed.status) {
    case "resolved": {
      item.setField("DOI", parsed.doi);
      if (operation === "short") {
        return processItem(item, operation, prefs);
      }
      removeAllDoiTags(item, prefs);
      await item.saveTx();
      return "updated";
    }

    case "unresolved": {
      removeAllDoiTags(item, prefs);
      if (prefs.tagNodoi) item.addTag(prefs.tagNodoi, 1);
      await item.saveTx();
      return "nodoi";
    }

    case "multiresolved": {
      const linkUrl = DoiService.buildCrossrefLinkUrl(ctx);
      Zotero.Attachments.linkFromURL({
        url: linkUrl,
        parentItemID: item.id,
        contentType: "text/html",
        title: "Multiple DOIs found",
      });
      item.removeTag(prefs.tagInvalid);
      item.removeTag(prefs.tagNodoi);
      if (prefs.tagMultiple) item.addTag(prefs.tagMultiple, 1);
      await item.saveTx();
      return "multiple";
    }

    default:
      Zotero.debug(`DOI Manager: CrossRef returned unknown status`);
      return "skipped";
  }
}

/**
 * Run a DOI operation against the supplied items. Safe to call concurrently —
 * subsequent calls are dropped while one is in flight.
 *
 * @param {Zotero.Item[]} items
 * @param {"short" | "long" | "check"} operation
 * @param {string} rootURI  Plugin root URI (for icon paths in the progress window).
 */
async function updateItems(items, operation, rootURI) {
  if (isRunning) return;

  const { supported, unsupported } = partitionItems(items);
  if (unsupported.length > 0) showUnsupportedWarning(unsupported);
  if (supported.length === 0) return;

  isRunning = true;
  const prefs = readPrefs();
  const counts = { updated: 0, invalid: 0, nodoi: 0, multiple: 0, skipped: 0 };

  const progressWindow = openProgressWindow(operation, rootURI);

  try {
    for (let i = 0; i < supported.length; i++) {
      updateProgress(progressWindow, i + 1, supported.length);
      const outcome = await processItem(supported[i], operation, prefs);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    showCompletion(progressWindow, operation, { counts }, prefs);
  } catch (error) {
    Zotero.debug(`DOI Manager: unexpected error in update loop: ${error}`);
    if (progressWindow) progressWindow.close();
  } finally {
    isRunning = false;
  }
}

var DoiUpdater = Object.freeze({
  updateItems,
});
