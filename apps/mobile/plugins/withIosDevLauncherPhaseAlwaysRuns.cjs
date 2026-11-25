const { withXcodeProject } = require("expo/config-plugins");

// expo-dev-launcher's phase edits the built Info.plist with no declared outputs, so Xcode warns on
// every build. It must run every build anyway; mark it so instead of relying on dependency analysis.
const PHASE_NAME = '"[Expo Dev Launcher] Strip Local Network Keys for Release"';

module.exports = function withIosDevLauncherPhaseAlwaysRuns(config) {
  return withXcodeProject(config, (modConfig) => {
    const phases = modConfig.modResults.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    for (const phase of Object.values(phases)) {
      if (typeof phase === "object" && phase.name === PHASE_NAME) {
        phase.alwaysOutOfDate = 1;
      }
    }
    return modConfig;
  });
};
