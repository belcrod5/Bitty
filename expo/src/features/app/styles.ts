import { StyleSheet } from "react-native";
import { appLayoutStyles } from "./styles/appLayoutStyles";
import { settingsControlStyles } from "./styles/settingsControlStyles";
import { mediaModalStyles } from "./styles/mediaModalStyles";

export const styles = StyleSheet.create({
  ...appLayoutStyles,
  ...settingsControlStyles,
  ...mediaModalStyles,
});
