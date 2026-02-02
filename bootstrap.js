// Startup -- load Zotero and constants
// Zotero 8 only: Zotero, Services, Cc, Ci are automatically available in bootstrap scope

var ShortDOI;
var chromeHandle;

function log(msg) {
  Zotero.debug("DOI Manager: " + msg);
}

async function install() {
  await Zotero.initializationPromise;
  log("Installed");
}

async function startup({
  id,
  version,
  resourceURI,
  rootURI = resourceURI.spec,
}) {
  await Zotero.initializationPromise;
  log("Starting");

  var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Ci.amIAddonManagerStartup,
  );
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zoteroshortdoi", "content/"],
    ["locale", "zoteroshortdoi", "en-US", "locale/en-US/"],
    ["locale", "zoteroshortdoi", "de", "locale/de/"],
  ]);
  log("Registered chrome");

  Services.scriptloader.loadSubScript(rootURI + "zoteroshortdoi.js");
  log("Loaded zoteroshortdoi.js");

  setDefaultPrefs(rootURI);
  log("Set default prefs");

  ShortDOI.init({ id, version, rootURI });
  log("Initialized ShortDOI");

  Zotero.PreferencePanes.register({
    pluginID: "zoteroshortdoi@wiernik.org",
    src: rootURI + "content/options.xhtml",
  });

  ShortDOI.addToAllWindows();
  log("Startup complete");
}

function setDefaultPrefs(rootURI) {
  var branch = Services.prefs.getDefaultBranch("");
  var obj = {
    pref(pref, value) {
      switch (typeof value) {
        case "boolean":
          branch.setBoolPref(pref, value);
          break;
        case "string":
          branch.setStringPref(pref, value);
          break;
        case "number":
          branch.setIntPref(pref, value);
          break;
        default:
          Zotero.logError(`Invalid type '${typeof value}' for pref '${pref}'`);
      }
    },
  };
  Services.scriptloader.loadSubScript(rootURI + "prefs.js", obj);
}

function onMainWindowLoad({ window }) {
  ShortDOI.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  ShortDOI.removeFromWindow(window);
}

function shutdown() {
  log("Shutting down");

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }

  ShortDOI.removeFromAllWindows();
  ShortDOI.shutdown();
  ShortDOI = undefined;
}

function uninstall() {
  log("Uninstalled");
}
