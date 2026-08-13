const buildingMacOS = process.env.BITTY_BUILDING_MACOS === "1";

module.exports = {
  dependencies: buildingMacOS
    ? {
        "react-native-keyboard-controller": {
          platforms: { ios: null },
        },
      }
    : {},
};
