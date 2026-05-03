/**
 * ShortDOI namespace — plugin lifecycle, item observer, menu dispatch.
 *
 * Heavy lifting lives in `lib/`:
 *   - `doi-service.js`  — pure URL and response parsing helpers.
 *   - `doi-http.js`     — Zotero.HTTP.request wrappers.
 *   - `doi-updater.js`  — async update loop and progress UI.
 *   - `menus.js`        — Zotero.MenuManager registration.
 */

ShortDOI = {
  id: null,
  version: null,
  rootURI: null,
  notifierID: null,
  menuHandle: null,

  /**
   * Initialize the plugin. Called once from bootstrap.js startup().
   *
   * @param {{id: string, version: string, rootURI: string}} params
   */
  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    this.notifierID = Zotero.Notifier.registerObserver(
      this.notifierCallback,
      ["item"],
      "shortdoi"
    );

    this.menuHandle = Menus.registerMenus((operation) =>
      this.updateSelectedItems(operation)
    );
  },

  /**
   * Tear down observers and registrations. Called from bootstrap.js shutdown().
   */
  shutdown() {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    if (this.menuHandle) {
      this.menuHandle.unregister();
      this.menuHandle = null;
    }
  },

  notifierCallback: {
    notify(event, type, ids) {
      if (event !== "add") return;
      const autoretrieve = Zotero.Prefs.get(
        "extensions.shortdoi.autoretrieve",
        true
      );
      if (!autoretrieve || autoretrieve === "none") return;
      DoiUpdater.updateItems(
        Zotero.Items.get(ids),
        autoretrieve,
        ShortDOI.rootURI
      );
    },
  },

  /**
   * Run an operation against the items currently selected in the active pane.
   *
   * @param {"short" | "long" | "check"} operation
   */
  updateSelectedItems(operation) {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return;
    DoiUpdater.updateItems(pane.getSelectedItems(), operation, this.rootURI);
  },
};
