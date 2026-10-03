const assert = require("node:assert/strict");
const test = require("node:test");
const plugin = require("./withRemovedLocationPermissions");

test("removes old location and Expo background entries but preserves unrelated native settings", async () => {
  const config = plugin({ name: "Bitty", slug: "bitty" });
  const result = await config.mods.ios.infoPlist({
    ...config,
    modRequest: { nextMod: async (value) => value },
    modResults: {
      NSLocationWhenInUseUsageDescription: "old",
      NSLocationAlwaysAndWhenInUseUsageDescription: "old",
      NSLocationAlwaysUsageDescription: "old",
      NSCalendarsFullAccessUsageDescription: "calendar",
      BGTaskSchedulerPermittedIdentifiers: ["com.expo.modules.backgroundtask.processing", "other.task"],
      UIBackgroundModes: ["location", "processing", "remote-notification", "fetch"],
    },
  });
  assert.deepEqual(result.modResults, {
    NSCalendarsFullAccessUsageDescription: "calendar",
    BGTaskSchedulerPermittedIdentifiers: ["other.task"],
    UIBackgroundModes: ["remote-notification", "fetch"],
  });
});

test("drops the permitted identifier key when only the old task used it", async () => {
  const config = plugin({ name: "Bitty", slug: "bitty" });
  const result = await config.mods.ios.infoPlist({
    ...config,
    modRequest: { nextMod: async (value) => value },
    modResults: { BGTaskSchedulerPermittedIdentifiers: ["com.expo.modules.backgroundtask.processing"] },
  });
  assert.equal("BGTaskSchedulerPermittedIdentifiers" in result.modResults, false);
});
