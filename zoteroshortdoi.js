// Startup -- load Zotero and constants
// Zotero 7+ only: Zotero is automatically available

const API_URLS = Object.freeze({
  SHORT_DOI: "https://shortdoi.org/",
  DOI_API: "https://doi.org/api/handles/",
  CROSSREF: "https://www.crossref.org/openurl?pid=zoteroDOI@wiernik.org&",
});

const ICONS = Object.freeze({
  ERROR: "chrome://zotero/skin/cross.png",
  SUCCESS: "chrome://zotero/skin/tick.png",
});

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

function _create(doc, name) {
  return doc.createElementNS(
    "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
    name,
  );
}

ShortDOI = {
  id: null,
  version: null,
  rootURI: null,
  addedElementIDs: [],
  notifierID: null,

  errorInvalid: null,
  errorNodoi: null,
  errorMultiple: null,
  errorInvalidShown: false,
  errorNodoiShown: false,
  errorMultipleShown: false,
  finalCountShown: false,
  cachedPrefs: null,
  pendingSaves: [],

  log(msg) {
    Zotero.debug("DOI Manager: " + msg);
  },

  getPref(pref) {
    return Zotero.Prefs.get("extensions.shortdoi." + pref, true);
  },

  setPref(pref, value) {
    return Zotero.Prefs.set("extensions.shortdoi." + pref, value, true);
  },

  cachePreferences() {
    this.cachedPrefs = {
      tagInvalid: this.getPref("tag_invalid"),
      tagNodoi: this.getPref("tag_nodoi"),
      tagMultiple: this.getPref("tag_multiple"),
      autoretrieve: this.getPref("autoretrieve"),
    };
    return this.cachedPrefs;
  },

  getCachedPref(key) {
    if (!this.cachedPrefs) {
      this.cachePreferences();
    }
    return this.cachedPrefs[key];
  },

  clearPrefCache() {
    this.cachedPrefs = null;
  },

  init({ id, version, rootURI } = {}) {
    this.initializeState();
    this.addedElementIDs = [];

    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    // Register the callback in Zotero as an item observer
    this.notifierID = Zotero.Notifier.registerObserver(this.notifierCallback, [
      "item",
    ]);
  },

  shutdown() {
    this.log("Shutting down");

    // Unregister the notifier
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }

    // Close any open progress windows
    if (this.progressWindow) {
      this.progressWindow.close();
      this.progressWindow = null;
    }

    // Clear state
    this.addedElementIDs = [];
    this.clearPrefCache();
  },

  createMenuItem(doc, stringBundle, config) {
    const item = _create(doc, config.type || "menuitem");
    item.id = config.id;

    if (config.labelKey) {
      item.setAttribute(
        "label",
        stringBundle.GetStringFromName(config.labelKey),
      );
    }

    if (config.className) {
      item.setAttribute("class", config.className);
    }

    if (config.checkboxType) {
      item.setAttribute("type", "checkbox");
    }

    if (config.handler) {
      item.addEventListener("command", config.handler);
    }

    return item;
  },

  createMenu(doc, stringBundle, config) {
    const menu = _create(doc, "menu");
    menu.id = config.id;

    if (config.className) {
      menu.setAttribute("class", config.className);
    }

    if (config.labelKey) {
      menu.setAttribute(
        "label",
        stringBundle.GetStringFromName(config.labelKey),
      );
    }

    const popup = _create(doc, "menupopup");
    popup.id = config.popupId;

    if (config.popupHandler) {
      popup.addEventListener("popupshowing", config.popupHandler);
    }

    menu.appendChild(popup);
    return { menu, popup };
  },

  addToWindow(window) {
    this.log("Updating window");

    const doc = window.document;
    const stringBundle = Services.strings.createBundle(
      "chrome://zoteroshortdoi/locale/zoteroshortdoi.properties",
    );

    // Item menu using factory
    const { menu: itemmenu, popup: itemmenupopup } = this.createMenu(
      doc,
      stringBundle,
      {
        id: "zotero-itemmenu-shortdoi-menu",
        popupId: "zotero-itemmenu-shortdoi-menupopup",
        className: "menu-iconic",
        labelKey: "shortdoi-menu-label",
      },
    );

    const menuItems = [
      {
        id: "zotero-itemmenu-shortdoi-short",
        labelKey: "shortdoi-menu-short-label",
        operation: "short",
      },
      {
        id: "zotero-itemmenu-shortdoi-long",
        labelKey: "shortdoi-menu-long-label",
        operation: "long",
      },
      {
        id: "zotero-itemmenu-shortdoi-check",
        labelKey: "shortdoi-menu-check-label",
        operation: "check",
      },
    ];

    menuItems.forEach((config) => {
      const item = this.createMenuItem(doc, stringBundle, {
        id: config.id,
        labelKey: config.labelKey,
        handler: () => this.updateSelectedItems(config.operation),
      });
      itemmenupopup.appendChild(item);
    });

    const targetMenu = doc.getElementById("zotero-itemmenu");
    if (targetMenu) {
      targetMenu.appendChild(itemmenu);
      this.storeAddedElement(itemmenu);
      this.log("Successfully added item menu");
    } else {
      this.log(
        "ERROR: Could not find zotero-itemmenu. Available IDs in doc might differ.",
      );
    }

    // Auto-retrieve settings menu
    const { menu: submenu, popup: submenupopup } = this.createMenu(
      doc,
      stringBundle,
      {
        id: "menu_Tools-shortdoi-menu",
        popupId: "menu_Tools-shortdoi-menu-popup",
        labelKey: "shortdoi-autoretrieve-label",
        popupHandler: () => this.setCheck(),
      },
    );

    const toolsMenuItems = [
      {
        id: "menu_Tools-shortdoi-menu-popup-short",
        labelKey: "shortdoi-autoretrieve-short-label",
        pref: "short",
      },
      {
        id: "menu_Tools-shortdoi-menu-popup-long",
        labelKey: "shortdoi-autoretrieve-long-label",
        pref: "long",
      },
      {
        id: "menu_Tools-shortdoi-menu-popup-check",
        labelKey: "shortdoi-autoretrieve-check-label",
        pref: "check",
      },
      {
        id: "menu_Tools-shortdoi-menu-popup-none",
        labelKey: "shortdoi-autoretrieve-no-label",
        pref: "none",
      },
    ];

    toolsMenuItems.forEach((config) => {
      const item = this.createMenuItem(doc, stringBundle, {
        id: config.id,
        labelKey: config.labelKey,
        checkboxType: true,
        handler: () => this.changePref(config.pref),
      });
      submenupopup.appendChild(item);
    });

    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (toolsPopup) {
      toolsPopup.appendChild(submenu);
      this.storeAddedElement(submenu);
      this.log("Successfully added tools menu");
    } else {
      this.log("ERROR: Could not find menu_ToolsPopup");
    }
  },

  addToAllWindows() {
    const windows = Zotero.getMainWindows();
    for (const win of windows) {
      if (!win.ZoteroPane) continue;
      this.addToWindow(win);
    }
  },

  storeAddedElement(elem) {
    if (!elem.id) {
      throw new Error("Element must have an id");
    }
    this.addedElementIDs.push(elem.id);
  },

  removeFromWindow(window) {
    const doc = window.document;
    for (const id of this.addedElementIDs) {
      const elem = doc.getElementById(id);
      if (elem) elem.remove();
    }
  },

  removeFromAllWindows() {
    const windows = Zotero.getMainWindows();
    for (const win of windows) {
      if (!win.ZoteroPane) continue;
      this.removeFromWindow(win);
    }
  },

  notifierCallback: {
    notify: function (event, type, ids, extraData) {
      if (event === "add") {
        const autoretrieve = ShortDOI.getPref("autoretrieve");
        if (autoretrieve && autoretrieve !== "none") {
          ShortDOI.updateItems(Zotero.Items.get(ids), autoretrieve);
        }
      }
    },
  },

  setCheck() {
    const document = Zotero.getMainWindow().document;
    const pref = this.getPref("autoretrieve");

    ["short", "long", "check", "none"].forEach((option) => {
      const elem = document.getElementById(
        `menu_Tools-shortdoi-menu-popup-${option}`,
      );
      if (elem) {
        elem.setAttribute("checked", pref === option);
      }
    });
  },

  changePref(option) {
    this.setPref("autoretrieve", option);
    this.clearPrefCache();
  },

  initializeState() {
    if (this.progressWindow) {
      this.progressWindow.close();
    }
    this.current = -1;
    this.toUpdate = 0;
    this.itemsToUpdate = null;
    this.numberOfUpdatedItems = 0;
    this.counter = 0;
    this.errorInvalid = null;
    this.errorNodoi = null;
    this.errorMultiple = null;
    this.errorInvalidShown = false;
    this.errorNodoiShown = false;
    this.errorMultipleShown = false;
    this.finalCountShown = false;
    this.pendingSaves = [];
    this.clearPrefCache();
  },

  showCompletionStatus(operation) {
    const prefs = this.cachedPrefs || this.cachePreferences();

    if (this.errorInvalid || this.errorNodoi || this.errorMultiple) {
      this.showErrorNotifications(prefs);
    } else {
      this.showSuccessNotification(operation);
    }
  },

  showErrorNotifications(prefs) {
    if (this.progressWindow) {
      this.progressWindow.close();
    }

    const errorConfigs = [
      {
        condition: this.errorInvalid && !this.errorInvalidShown,
        headline: "Invalid DOI",
        tag: prefs.tagInvalid,
        message: "Invalid DOIs were found.",
        tagMessage: "Invalid DOIs were found. These have been tagged with",
        shownFlag: "errorInvalidShown",
      },
      {
        condition: this.errorNodoi && !this.errorNodoiShown,
        headline: "DOI not found",
        tag: prefs.tagNodoi,
        message: "No DOI was found for some items.",
        tagMessage:
          "No DOI was found for some items. These have been tagged with",
        shownFlag: "errorNodoiShown",
      },
      {
        condition: this.errorMultiple && !this.errorMultipleShown,
        headline: "Multiple possible DOIs",
        tag: prefs.tagMultiple,
        message: "Some items had multiple possible DOIs.",
        tagMessage:
          "Some items had multiple possible DOIs. Links to lists of DOIs have been added and tagged with",
        shownFlag: "errorMultipleShown",
      },
    ];

    errorConfigs.forEach((config) => {
      if (config.condition) {
        this.showErrorWindow(config);
        this[config.shownFlag] = true;
      }
    });
  },

  showErrorWindow(config) {
    const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
    progressWindow.changeHeadline(config.headline);

    const message =
      config.tag !== ""
        ? `${config.tagMessage} '${config.tag}'.`
        : config.message;

    progressWindow.progress = new progressWindow.ItemProgress(
      ICONS.ERROR,
      message,
    );
    progressWindow.progress.setError();
    progressWindow.show();
    progressWindow.startCloseTimer(8000);
  },

  showSuccessNotification(operation) {
    if (this.finalCountShown) return;

    if (!this.progressWindow) {
      this.progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
      this.progressWindow.show();
    }

    this.progressWindow.changeHeadline("Finished");
    this.progressWindow.progress = new this.progressWindow.ItemProgress(
      ICONS.SUCCESS,
      "",
    );
    this.progressWindow.progress.setProgress(100);

    const messages = {
      short: `shortDOIs updated for ${this.counter} items.`,
      long: `Long DOIs updated for ${this.counter} items.`,
      check: `DOIs verified for ${this.counter} items.`,
    };

    this.progressWindow.progress.setText(messages[operation] || messages.check);
    this.progressWindow.startCloseTimer(4000);
    this.finalCountShown = true;
  },

  resetState(operation) {
    if (operation === "initial") {
      this.initializeState();
    } else {
      this.showCompletionStatus(operation);
    }
  },

  removeAllDoiTags(item) {
    const prefs = this.cachedPrefs || this.cachePreferences();
    item.removeTag(prefs.tagInvalid);
    item.removeTag(prefs.tagMultiple);
    item.removeTag(prefs.tagNodoi);
  },

  hasAnyDoiTag(item) {
    const prefs = this.cachedPrefs || this.cachePreferences();
    return (
      item.hasTag(prefs.tagInvalid) ||
      item.hasTag(prefs.tagMultiple) ||
      item.hasTag(prefs.tagNodoi)
    );
  },

  generateItemUrl(item, operation) {
    let doi = item.getField("DOI");

    if (!doi) {
      return this.crossrefLookup(item, operation);
    }

    if (typeof doi !== "string") {
      return "invalid";
    }

    doi = Zotero.Utilities.cleanDOI(doi);
    if (!doi) {
      return "invalid";
    }

    if (operation === "short" && !doi.match(/10\/[^\s]*[^\s.,]/)) {
      return `${API_URLS.SHORT_DOI}${encodeURIComponent(doi)}?format=json`;
    }

    return `${API_URLS.DOI_API}${encodeURIComponent(doi)}`;
  },

  updateSelectedItems(operation) {
    this.updateItems(
      Zotero.getActiveZoteroPane().getSelectedItems(),
      operation,
    );
  },

  updateItems(items, operation) {
    const supportedTypeIDs = SUPPORTED_ITEM_TYPES.map((type) =>
      Zotero.ItemTypes.getID(type),
    ).filter((id) => id !== false);
    const regularItems = items.filter(
      (item) => item.isRegularItem() && !item.isFeedItem,
    );

    const filteredItems = regularItems.filter((item) =>
      supportedTypeIDs.includes(item.itemTypeID),
    );
    const unsupportedItems = regularItems.filter(
      (item) => !supportedTypeIDs.includes(item.itemTypeID),
    );

    if (unsupportedItems.length > 0) {
      this.showUnsupportedItemsWarning(unsupportedItems);
    }

    if (
      filteredItems.length === 0 ||
      this.numberOfUpdatedItems < this.toUpdate
    ) {
      return;
    }
    this.initializeState();
    this.cachePreferences();

    this.toUpdate = filteredItems.length;
    this.itemsToUpdate = filteredItems;
    this.setupProgressWindow(operation);
    this.updateNextItem(operation);
  },

  showUnsupportedItemsWarning(unsupportedItems) {
    const unsupportedTypes = [
      ...new Set(
        unsupportedItems.map((item) =>
          Zotero.ItemTypes.getName(item.itemTypeID),
        ),
      ),
    ];

    const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
    progressWindow.changeHeadline("Unsupported Item Types");
    progressWindow.progress = new progressWindow.ItemProgress(
      ICONS.ERROR,
      `${unsupportedItems.length} item(s) skipped (unsupported types: ${unsupportedTypes.join(", ")})`,
    );
    progressWindow.progress.setError();
    progressWindow.show();
    progressWindow.startCloseTimer(6000);
  },

  setupProgressWindow(operation) {
    if (this.progressWindow) {
      this.progressWindow.close();
    }

    this.progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });

    const icon = `chrome://zotero/skin/toolbar-advanced-search${Zotero.hiDPI ? "@2x" : ""}.png`;
    const headlines = {
      short: "Getting shortDOIs",
      long: "Getting long DOIs",
      check: "Validating DOIs and removing extra text",
    };

    this.progressWindow.changeHeadline(
      headlines[operation] || headlines.check,
      icon,
    );

    const doiIcon = `${this.rootURI}skin/doi${Zotero.hiDPI ? "@2x" : ""}.png`;
    this.progressWindow.progress = new this.progressWindow.ItemProgress(
      doiIcon,
      "Checking DOIs.",
    );
    this.progressWindow.show();
  },

  updateNextItem(operation) {
    this.numberOfUpdatedItems++;

    if (this.current === this.toUpdate - 1) {
      this.resetState(operation);
      return;
    }

    this.current++;
    const percent = Math.round(
      (this.numberOfUpdatedItems / this.toUpdate) * 100,
    );
    this.progressWindow.progress.setProgress(percent);
    this.progressWindow.progress.setText(
      `Item ${this.current} of ${this.toUpdate}`,
    );

    this.updateItem(this.itemsToUpdate[this.current], operation);
  },

  updateItem(item, operation) {
    const url = this.generateItemUrl(item, operation);

    if (!url) {
      if (item.hasTag(this.getCachedPref("tagInvalid"))) {
        item.removeTag(this.getCachedPref("tagInvalid"));
        item.saveTx();
      }
      this.updateNextItem(operation);
      return;
    }

    if (url === "invalid") {
      this.invalidate(item, operation);
      return;
    }

    const oldDOI = item.getField("DOI");
    this.performDOIRequest(url, item, oldDOI, operation);
  },

  performDOIRequest(url, item, oldDOI, operation) {
    const req = new XMLHttpRequest();
    req.open("GET", url, true);
    req.responseType = "json";

    req.onerror = () => {
      this.log("Network error fetching DOI");
      this.updateNextItem(operation);
    };

    req.onreadystatechange = () => {
      if (req.readyState !== 4) return;
      this.handleDOIResponse(req, item, oldDOI, operation);
    };

    req.send(null);
  },

  handleDOIResponse(req, item, oldDOI, operation) {
    // Handle error statuses
    if (req.status === 400 || req.status === 404) {
      this.invalidate(item, operation);
      return;
    }

    if (req.status !== 200) {
      this.updateNextItem(operation);
      return;
    }

    if (!item.isRegularItem()) {
      this.updateNextItem(operation);
      return;
    }

    const response = req.response;

    switch (operation) {
      case "short":
        this.handleShortDOIResponse(response, item, oldDOI);
        break;
      case "long":
        this.handleLongDOIResponse(response, item, oldDOI);
        break;
      case "check":
        this.handleCheckDOIResponse(response, item, oldDOI);
        break;
    }
  },

  handleShortDOIResponse(response, item, oldDOI) {
    // Get shortDOI from whichever field the API returns
    const shortDOI = (response.ShortDOI || response.handle || "").toLowerCase();

    if (!shortDOI) {
      this.invalidate(item, "short");
      return;
    }

    item.setField("DOI", shortDOI);
    this.removeAllDoiTags(item);
    item.saveTx();
    this.counter++;
    this.updateNextItem("short");
  },

  handleLongDOIResponse(response, item, oldDOI) {
    if (response.responseCode !== 1) {
      this.invalidate(item, "long");
      return;
    }

    // Get long DOI - for short DOIs it's in values["1"], otherwise in handle
    const isShortDOI = oldDOI.match(/10\/[^\s]*[^\s.,]/);
    let longDOI;

    if (isShortDOI && response.values && response.values["1"]) {
      longDOI = response.values["1"].data.value.toLowerCase();
    } else {
      longDOI = (response.handle || "").toLowerCase();
    }

    if (!longDOI) {
      this.invalidate(item, "long");
      return;
    }

    item.setField("DOI", longDOI);
    this.removeAllDoiTags(item);
    item.saveTx();
    this.counter++;
    this.updateNextItem("long");
  },

  handleCheckDOIResponse(response, item, oldDOI) {
    if (response.responseCode === 200) {
      this.invalidate(item, "check");
      return;
    }

    if (response.handle !== oldDOI) {
      const newDOI = response.handle.toLowerCase();
      item.setField("DOI", newDOI);
      this.removeAllDoiTags(item);
      item.saveTx();
    } else if (this.hasAnyDoiTag(item)) {
      this.removeAllDoiTags(item);
      item.saveTx();
    }

    this.counter++;
    this.updateNextItem("check");
  },

  invalidate(item, operation) {
    if (item.isRegularItem()) {
      this.errorInvalid = true;
      const tagInvalid = this.getCachedPref("tagInvalid");
      if (tagInvalid !== "") {
        item.addTag(tagInvalid, 1);
      }
      item.saveTx();
    }
    this.updateNextItem(operation);
  },

  crossrefLookup(item, operation) {
    const ctx = Zotero.OpenURL.createContextObject(item, "1.0");

    if (!ctx) {
      return false;
    }

    const url = `${API_URLS.CROSSREF}${ctx}&multihit=true`;
    const req = new XMLHttpRequest();
    req.open("GET", url, true);

    req.onerror = () => {
      this.log("Network error during CrossRef lookup");
      this.updateNextItem(operation);
    };

    req.onreadystatechange = () => {
      if (req.readyState !== 4) return;

      if (req.status !== 200) {
        this.updateNextItem(operation);
        return;
      }

      this.handleCrossrefResponse(req, item, operation);
    };

    req.send(null);
    return false;
  },

  handleCrossrefResponse(req, item, operation) {
    const response = req.responseXML.getElementsByTagName("query")[0];
    const status = response.getAttribute("status");
    const prefs = this.cachedPrefs || this.cachePreferences();

    switch (status) {
      case "resolved":
        this.handleCrossrefResolved(response, item, operation);
        break;

      case "unresolved":
        this.handleCrossrefUnresolved(item, prefs);
        break;

      case "multiresolved":
        this.handleCrossrefMultiresolved(item, prefs);
        break;

      default:
        Zotero.debug(
          `Zotero DOI Manager: CrossRef lookup: Unknown status code: ${status}`,
        );
        this.updateNextItem(operation);
    }
  },

  handleCrossrefResolved(response, item, operation) {
    const doi = response.getElementsByTagName("doi")[0].childNodes[0].nodeValue;

    item.setField("DOI", doi);

    if (operation === "short") {
      this.updateItem(item, operation);
    } else {
      this.removeAllDoiTags(item);
      item.saveTx();
      this.counter++;
      this.updateNextItem(operation);
    }
  },

  handleCrossrefUnresolved(item, prefs) {
    this.errorNodoi = true;
    this.removeAllDoiTags(item);

    if (prefs.tagNodoi !== "") {
      item.addTag(prefs.tagNodoi, 1);
    }

    item.saveTx();
    this.updateNextItem("check");
  },

  handleCrossrefMultiresolved(item, prefs) {
    this.errorMultiple = true;

    const ctx = Zotero.OpenURL.createContextObject(item, "1.0");
    Zotero.Attachments.linkFromURL({
      url: API_URLS.CROSSREF + ctx,
      parentItemID: item.id,
      contentType: "text/html",
      title: "Multiple DOIs found",
    });

    if (item.hasTag(prefs.tagInvalid) || item.hasTag(prefs.tagNodoi)) {
      item.removeTag(prefs.tagInvalid);
      item.removeTag(prefs.tagNodoi);
    }

    if (prefs.tagMultiple !== "") {
      item.addTag(prefs.tagMultiple, 1);
    }

    item.saveTx();
    this.updateNextItem("check");
  },
};
