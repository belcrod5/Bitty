import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export type AppModalProps = {
  animationType?: "none" | "slide" | "fade";
  backdropColor?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  onRequestClose?: () => void;
  onShow?: () => void;
  presentationStyle?: "fullScreen";
  statusBarTranslucent?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  transparent?: boolean;
  visible?: boolean;
};
