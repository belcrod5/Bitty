const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const xcode = require("xcode");
const plist = require("@expo/plist").default;
const { IOSConfig } = require("expo/config-plugins");
const plugin = require("./withPushNotificationPresentation");

test("communication capability and supported intent merge with existing app settings", async () => {
  const config = plugin({ name: "Bitty", slug: "bitty" });
  const modRequest = { nextMod: async (value) => value };
  const entitlements = await config.mods.ios.entitlements({ ...config, modRequest,
    modResults: { "aps-environment": "development", "com.apple.developer.usernotifications.time-sensitive": true } });
  assert.deepEqual(entitlements.modResults, {
    "aps-environment": "development", "com.apple.developer.usernotifications.time-sensitive": true,
    "com.apple.developer.usernotifications.communication": true,
  });
  const original = { NSUserActivityTypes: ["ExistingActivity", "INSendMessageIntent"], UIBackgroundModes: ["remote-notification"] };
  const info = await config.mods.ios.infoPlist({ ...config, modRequest, modResults: original });
  assert.deepEqual(info.modResults, original);
});

test("clean Expo template generates one embedded extension with its own resources and survives repeated prebuild mods", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bitty-notification-plugin-"));
  try {
    execFileSync("tar", ["-xzf", path.join(path.dirname(require.resolve("expo/package.json")), "template.tgz"),
      "-C", temp, "package/ios/HelloWorld.xcodeproj/project.pbxproj"]);
    const projectPath = path.join(temp, "package/ios/HelloWorld.xcodeproj/project.pbxproj");
    let project = xcode.project(projectPath);
    project.parseSync();
    const config = plugin({ name: "Bitty", slug: "bitty", version: "1.0.0", ios: { bundleIdentifier: "app.bitty.mobile" } });
    const modRequest = { projectRoot: path.resolve(__dirname, ".."), platformProjectRoot: path.join(temp, "package/ios"),
      nextMod: async (value) => value };
    await config.mods.ios.xcodeproj({ ...config, modRequest, modResults: project });
    const firstProject = project.writeSync();
    fs.writeFileSync(projectPath, firstProject);
    project = xcode.project(projectPath);
    project.parseSync();
    await config.mods.ios.xcodeproj({ ...config, modRequest, modResults: project });
    assert.equal(project.writeSync(), firstProject, "no duplicated target, dependencies, phases or files");
    const targets = IOSConfig.Target.getNativeTargets(project);
    assert.equal(targets.length, 2);
    const [extensionId, extension] = targets.find(([, value]) => value.name.replaceAll('"', "") === "BittyNotificationService");
    const [hostId, host] = targets.find(([, value]) => value.productType.replaceAll('"', "") === "com.apple.product-type.application");
    assert.ok(host.dependencies.some(({ value }) => project.hash.project.objects.PBXTargetDependency[value].target === extensionId));
    const embed = Object.values(project.hash.project.objects.PBXCopyFilesBuildPhase).find((value) => value.isa === "PBXCopyFilesBuildPhase");
    assert.equal(embed.dstSubfolderSpec, 13, "extension is embedded in PlugIns");
    assert.ok(host.buildPhases.some(({ value }) => project.hash.project.objects.PBXCopyFilesBuildPhase[value] === embed));
    assert.ok(embed.files.some(({ value }) => project.pbxBuildFileSection()[value].fileRef === extension.productReference));
    const resourcePhase = project.pbxResourcesBuildPhaseObj(extensionId);
    const sources = project.pbxSourcesBuildPhaseObj(extensionId);
    assert.equal(sources.files.length, 1);
    assert.equal(resourcePhase.files.length, 5);
    for (const { value } of [...sources.files, ...resourcePhase.files]) {
      const ref = project.pbxFileReferenceSection()[project.pbxBuildFileSection()[value].fileRef];
      assert.ok(fs.existsSync(path.join(modRequest.platformProjectRoot, ref.path.replaceAll('"', ""))));
      assert.ok(!project.pbxResourcesBuildPhaseObj(hostId).files.some((entry) => entry.value === value));
    }
    const settings = IOSConfig.Target.getXCBuildConfigurationFromPbxproj(project, { targetName: "BittyNotificationService" }).buildSettings;
    assert.equal(settings.APPLICATION_EXTENSION_API_ONLY, "YES");
    assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, "app.bitty.mobile.notifications");
    const extensionPlist = plist.parse(fs.readFileSync(path.join(modRequest.platformProjectRoot, settings.INFOPLIST_FILE), "utf8"));
    assert.equal(extensionPlist.NSExtension.NSExtensionPointIdentifier, "com.apple.usernotifications.service");
    assert.equal(extensionPlist.NSExtension.NSExtensionPrincipalClass, "$(PRODUCT_MODULE_NAME).NotificationService");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
