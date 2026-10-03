const { withInfoPlist } = require("expo/config-plugins");

module.exports = (config) => withInfoPlist(config, (next) => {
  // Expo prebuild merges an existing native plist; remove permissions from older builds too.
  delete next.modResults.NSLocationWhenInUseUsageDescription;
  delete next.modResults.NSLocationAlwaysAndWhenInUseUsageDescription;
  delete next.modResults.NSLocationAlwaysUsageDescription;
  if (Array.isArray(next.modResults.BGTaskSchedulerPermittedIdentifiers)) {
    next.modResults.BGTaskSchedulerPermittedIdentifiers = next.modResults.BGTaskSchedulerPermittedIdentifiers
      .filter((id) => id !== "com.expo.modules.backgroundtask.processing");
    if (next.modResults.BGTaskSchedulerPermittedIdentifiers.length === 0) {
      delete next.modResults.BGTaskSchedulerPermittedIdentifiers;
    }
  }
  if (Array.isArray(next.modResults.UIBackgroundModes)) {
    next.modResults.UIBackgroundModes = next.modResults.UIBackgroundModes.filter((mode) => mode !== "location" && mode !== "processing");
  }
  return next;
});
