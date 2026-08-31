const buildingMacOS = process.env.BITTY_BUILDING_MACOS === "1";

module.exports = {
  dependencies: buildingMacOS
    ? {
        "@react-native-community/datetimepicker": {
          platforms: { ios: null },
        },
        "react-native-keyboard-controller": {
          platforms: { ios: null },
        },
      }
    : {},
};
