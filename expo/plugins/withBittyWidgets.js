const fs = require("node:fs");
const path = require("node:path");
const plist = require("@expo/plist").default;
const { IOSConfig, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const TARGET = "BittyWidgets";
module.exports = (config) => {
  const bundleId = config.ios.bundleIdentifier;
  const appGroup = `group.${bundleId}.widgets`;
  config = withEntitlementsPlist(config, (next) => {
    next.modResults["com.apple.security.application-groups"] = [...new Set([
      ...(next.modResults["com.apple.security.application-groups"] || []), appGroup,
    ])];
    return next;
  });
  config = withInfoPlist(config, (next) => {
    next.modResults.BittyWidgetAppGroup = appGroup;
    return next;
  });
  return withXcodeProject(config, (next) => {
    const project = next.modResults;
    const { projectRoot, platformProjectRoot } = next.modRequest;
    const destination = path.join(platformProjectRoot, TARGET);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(projectRoot, "widgets/BittyWidget.swift"), path.join(destination, "BittyWidget.swift"));
    fs.writeFileSync(path.join(destination, "Info.plist"), plist.build({
      CFBundleDisplayName: "Bitty", CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
      CFBundleName: "$(PRODUCT_NAME)", CFBundleExecutable: "$(EXECUTABLE_NAME)", CFBundlePackageType: "XPC!",
      CFBundleShortVersionString: "$(MARKETING_VERSION)", CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
      BittyWidgetAppGroup: appGroup,
      NSExtension: { NSExtensionPointIdentifier: "com.apple.widgetkit-extension" },
    }));
    fs.writeFileSync(path.join(destination, `${TARGET}.entitlements`), plist.build({
      "com.apple.security.application-groups": [appGroup],
    }));
    let extension = Object.entries(project.pbxNativeTargetSection())
      .find(([key, value]) => !key.endsWith("_comment") && value.name.replaceAll('"', "") === TARGET);
    if (!extension) {
      project.hash.project.objects.PBXTargetDependency ||= {};
      project.hash.project.objects.PBXContainerItemProxy ||= {};
      const added = project.addTarget(TARGET, "app_extension", TARGET, `${bundleId}.widgets`);
      extension = [added.uuid, added.pbxNativeTarget];
      project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", added.uuid);
      project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", added.uuid);
      project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", added.uuid);
    }
    const [targetUuid, target] = extension;
    const utils = IOSConfig.XcodeUtils;
    utils.ensureGroupRecursively(project, TARGET);
    utils.addBuildSourceFileToGroup({ project, targetUuid, groupName: TARGET, filepath: `${TARGET}/BittyWidget.swift` });
    const host = IOSConfig.Target.getXCBuildConfigurationFromPbxproj(project).buildSettings;
    for (const [, configuration] of utils.getBuildConfigurationsForListId(project, target.buildConfigurationList)) {
      Object.assign(configuration.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: "YES", CLANG_ENABLE_MODULES: "YES", SKIP_INSTALL: "YES",
        CODE_SIGN_STYLE: "Automatic", CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
        INFOPLIST_FILE: `${TARGET}/Info.plist`, IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        PRODUCT_BUNDLE_IDENTIFIER: `${bundleId}.widgets`, PRODUCT_MODULE_NAME: "BittyWidgetExtension", SWIFT_VERSION: "5.0",
        TARGETED_DEVICE_FAMILY: host.TARGETED_DEVICE_FAMILY || '"1,2"',
        CURRENT_PROJECT_VERSION: host.CURRENT_PROJECT_VERSION || "1",
        MARKETING_VERSION: host.MARKETING_VERSION || next.version || "1.0.0",
        ...(host.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: host.DEVELOPMENT_TEAM } : {}),
      });
    }
    return next;
  });
};
