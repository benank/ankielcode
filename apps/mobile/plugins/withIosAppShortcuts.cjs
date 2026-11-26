"use strict";

// App Intents must compile into the app target: Apple's metadata extraction skips static pods.

const fs = require("fs");
const path = require("path");
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const SOURCE_DIR = path.join(__dirname, "..", "modules", "ankiel-app-intents", "app-target");
const SWIFT_FILE = "AnkielAppShortcuts.swift";
const STRING_CATALOGS = ["AppShortcuts.xcstrings", "Localizable.xcstrings"];
// The catalogs' languages, so Xcode compiles every one of them into the bundle.
const REGIONS = ["de", "es", "fr", "ja", "ko", "pt-BR", "ru", "sv", "zh-Hans"];

function withAppTargetFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const destination = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName);
      for (const file of [SWIFT_FILE, ...STRING_CATALOGS]) {
        fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(destination, file));
      }
      return cfg;
    },
  ]);
}

function setLastKnownFileType(project, filepath, fileType) {
  const references = project.pbxFileReferenceSection();
  for (const [key, reference] of Object.entries(references)) {
    if (key.endsWith("_comment")) continue;
    if (String(reference.path).replace(/"/g, "") === filepath) {
      reference.lastKnownFileType = fileType;
    }
  }
}

function withAppTargetWiring(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const target = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
    const link = (file, add) => {
      const filepath = `${projectName}/${file}`;
      if (!project.hasFile(filepath)) {
        add({
          filepath,
          groupName: projectName,
          project,
          targetUuid: target.uuid,
          isBuildFile: true,
        });
      }
      return filepath;
    };

    link(SWIFT_FILE, IOSConfig.XcodeUtils.addBuildSourceFileToGroup);
    for (const catalog of STRING_CATALOGS) {
      const filepath = link(catalog, IOSConfig.XcodeUtils.addResourceFileToGroup);
      setLastKnownFileType(project, filepath, "text.json.xcstrings");
    }
    for (const region of REGIONS) {
      project.addKnownRegion(region.includes("-") ? `"${region}"` : region);
    }
    return cfg;
  });
}

module.exports = function withIosAppShortcuts(config) {
  return withAppTargetWiring(withAppTargetFiles(config));
};
