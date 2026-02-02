SET /P version= Enter version number:
rm -f zotero-doi-manager-"%version%".xpi
zip -r zotero-doi-manager-"%version%".xpi content locale skin bootstrap.js manifest.json prefs.js zoteroshortdoi.js