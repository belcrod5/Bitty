const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === "macos" &&
    (moduleName === "react-native" || moduleName.startsWith("react-native/"))
  ) {
    return context.resolveRequest(
      context,
      moduleName.replace("react-native", "react-native-macos"),
      platform,
    );
  }

  return context.resolveRequest(context, moduleName, platform);
};

const originalGetModulesRunBeforeMainModule =
  config.serializer.getModulesRunBeforeMainModule;

config.serializer.getModulesRunBeforeMainModule = () => {
  try {
    return [
      require.resolve("react-native/Libraries/Core/InitializeCore"),
      require.resolve("react-native-macos/Libraries/Core/InitializeCore"),
    ];
  } catch {}

  return originalGetModulesRunBeforeMainModule();
};

module.exports = config;
