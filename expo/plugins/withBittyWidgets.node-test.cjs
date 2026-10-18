const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const xcode = require("xcode");
const plist = require("@expo/plist").default;
const { IOSConfig } = require("expo/config-plugins");
const plugin = require("./withBittyWidgets");

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
    const [extensionId, extension] = targets.find(([, value]) => value.name.replaceAll('"', "") === "BittyWidgets");
    const [hostId, host] = targets.find(([, value]) => value.productType.replaceAll('"', "") === "com.apple.product-type.application");
    assert.ok(host.dependencies.some(({ value }) => project.hash.project.objects.PBXTargetDependency[value].target === extensionId));
    const embed = Object.values(project.hash.project.objects.PBXCopyFilesBuildPhase).find((value) => value.isa === "PBXCopyFilesBuildPhase");
    assert.equal(embed.dstSubfolderSpec, 13, "extension is embedded in PlugIns");
    assert.ok(host.buildPhases.some(({ value }) => project.hash.project.objects.PBXCopyFilesBuildPhase[value] === embed));
    assert.ok(embed.files.some(({ value }) => project.pbxBuildFileSection()[value].fileRef === extension.productReference));
    const resourcePhase = project.pbxResourcesBuildPhaseObj(extensionId);
    const sources = project.pbxSourcesBuildPhaseObj(extensionId);
    assert.equal(sources.files.length, 1);
    assert.equal(resourcePhase.files.length, 0);
    for (const { value } of [...sources.files, ...resourcePhase.files]) {
      const ref = project.pbxFileReferenceSection()[project.pbxBuildFileSection()[value].fileRef];
      assert.ok(fs.existsSync(path.join(modRequest.platformProjectRoot, ref.path.replaceAll('"', ""))));
      assert.ok(!project.pbxResourcesBuildPhaseObj(hostId).files.some((entry) => entry.value === value));
    }
    const settings = IOSConfig.Target.getXCBuildConfigurationFromPbxproj(project, { targetName: "BittyWidgets" }).buildSettings;
    assert.equal(settings.APPLICATION_EXTENSION_API_ONLY, "YES");
    assert.equal(settings.PRODUCT_MODULE_NAME, "BittyWidgetExtension", "extension module must not shadow the BittyWidgets bridge Pod");
    assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, "app.bitty.mobile.widgets");
    const extensionPlist = plist.parse(fs.readFileSync(path.join(modRequest.platformProjectRoot, settings.INFOPLIST_FILE), "utf8"));
    assert.equal(extensionPlist.NSExtension.NSExtensionPointIdentifier, "com.apple.widgetkit-extension");
    assert.equal(extensionPlist.BittyWidgetAppGroup, "group.app.bitty.mobile.widgets");
    assert.equal(settings.SKIP_INSTALL, "YES");
    assert.equal(settings.IPHONEOS_DEPLOYMENT_TARGET, "17.0");
    const entitlements = plist.parse(fs.readFileSync(path.join(modRequest.platformProjectRoot, settings.CODE_SIGN_ENTITLEMENTS), "utf8"));
    assert.deepEqual(entitlements["com.apple.security.application-groups"], ["group.app.bitty.mobile.widgets"]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});


test("host app gets the same App Group without replacing existing capabilities", async () => {
  const config = plugin({ name: "Bitty", slug: "bitty", ios: { bundleIdentifier: "app.bitty.mobile" } });
  const modRequest = { nextMod: async (value) => value };
  const entitlements = await config.mods.ios.entitlements({ ...config, modRequest,
    modResults: { "aps-environment": "development", "com.apple.security.application-groups": ["group.existing"] } });
  assert.deepEqual(entitlements.modResults["com.apple.security.application-groups"], ["group.existing", "group.app.bitty.mobile.widgets"]);
  assert.equal(entitlements.modResults["aps-environment"], "development");
  const info = await config.mods.ios.infoPlist({ ...config, modRequest, modResults: {} });
  assert.equal(info.modResults.BittyWidgetAppGroup, "group.app.bitty.mobile.widgets");
});
