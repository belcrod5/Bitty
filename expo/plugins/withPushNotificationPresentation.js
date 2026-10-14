const fs = require("node:fs");
const path = require("node:path");
const plist = require("@expo/plist").default;
const { IOSConfig, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const TARGET = "BittyNotificationService";

module.exports = (config) => {
  config = withEntitlementsPlist(config, (next) => {
    next.modResults["com.apple.developer.usernotifications.communication"] = true;
    return next;
  });
  config = withInfoPlist(config, (next) => {
    next.modResults.NSUserActivityTypes = Array.from(new Set([
      ...(next.modResults.NSUserActivityTypes || []), "INSendMessageIntent",
    ]));
    return next;
  });
  return withXcodeProject(config, (next) => {
    const project = next.modResults;
    const { projectRoot, platformProjectRoot } = next.modRequest;
    const destination = path.join(platformProjectRoot, TARGET);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(projectRoot, "notifications", TARGET, "NotificationService.swift"),
      path.join(destination, "NotificationService.swift"));
    const icons = fs.readdirSync(path.join(projectRoot, "notifications/assets/icons"))
      .filter((name) => name.endsWith(".png")).sort();
    for (const icon of icons) {
      fs.copyFileSync(path.join(projectRoot, "notifications/assets/icons", icon), path.join(destination, icon));
    }
    // Generated beside the Swift source so clean prebuilds need no manual Xcode changes.
    fs.writeFileSync(path.join(destination, "Info.plist"), plist.build({
      CFBundleDisplayName: "Bitty Notifications",
      CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
      CFBundleName: "$(PRODUCT_NAME)", CFBundleExecutable: "$(EXECUTABLE_NAME)",
      CFBundlePackageType: "XPC!", CFBundleShortVersionString: "$(MARKETING_VERSION)",
      CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
      NSExtension: {
        NSExtensionPointIdentifier: "com.apple.usernotifications.service",
        NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
      },
    }));
    let extension = Object.entries(project.pbxNativeTargetSection())
      .find(([key, value]) => !key.endsWith("_comment") && value.name.replaceAll('"', "") === TARGET);
    if (!extension) {
      // xcode's addTarget only adds dependencies when these sections already exist.
      // A fresh Expo template has no extensions or target-dependency sections yet.
      project.hash.project.objects.PBXTargetDependency ||= {};
      project.hash.project.objects.PBXContainerItemProxy ||= {};
      const added = project.addTarget(TARGET, "app_extension", TARGET, `${next.ios.bundleIdentifier}.notifications`);
      extension = [added.uuid, added.pbxNativeTarget];
      project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", added.uuid);
      project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", added.uuid);
      project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", added.uuid);
    }
    const [targetUuid, target] = extension;
    const utils = IOSConfig.XcodeUtils;
    utils.ensureGroupRecursively(project, TARGET);
    utils.addBuildSourceFileToGroup({ project, targetUuid, groupName: TARGET,
      filepath: `${TARGET}/NotificationService.swift` });
    for (const icon of icons) {
      utils.addResourceFileToGroup({ project, targetUuid, groupName: TARGET,
        filepath: `${TARGET}/${icon}`, isBuildFile: true });
    }
    const host = IOSConfig.Target.getXCBuildConfigurationFromPbxproj(project).buildSettings;
    for (const [, configuration] of utils.getBuildConfigurationsForListId(project, target.buildConfigurationList)) {
      Object.assign(configuration.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: "YES", CLANG_ENABLE_MODULES: "YES",
        CODE_SIGN_STYLE: "Automatic", INFOPLIST_FILE: `${TARGET}/Info.plist`,
        IPHONEOS_DEPLOYMENT_TARGET: host.IPHONEOS_DEPLOYMENT_TARGET || "16.4",
        PRODUCT_BUNDLE_IDENTIFIER: `${next.ios.bundleIdentifier}.notifications`,
        SWIFT_VERSION: "5.0", TARGETED_DEVICE_FAMILY: host.TARGETED_DEVICE_FAMILY || '"1,2"',
        CURRENT_PROJECT_VERSION: host.CURRENT_PROJECT_VERSION || "1",
        MARKETING_VERSION: host.MARKETING_VERSION || next.version || "1.0.0",
        ...(host.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: host.DEVELOPMENT_TEAM } : {}),
      });
    }
    return next;
  });
};
