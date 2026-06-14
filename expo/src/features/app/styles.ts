import { StyleSheet } from "react-native";
import { appLayoutStyles } from "./styles/appLayoutStyles";
import { debugControlStyles } from "./styles/debugControlStyles";
import { mediaModalStyles } from "./styles/mediaModalStyles";

export const styles = StyleSheet.create({
  ...appLayoutStyles,
  ...debugControlStyles,
  ...mediaModalStyles,
});
