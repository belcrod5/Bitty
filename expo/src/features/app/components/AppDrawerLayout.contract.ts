import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export type AppDrawerLayoutProps = {
  children: ReactNode;
  drawerStyle?: StyleProp<ViewStyle>;
  onClose: () => void;
  onOpen: () => void;
  onTransitionEnd?: (closing: boolean) => void;
  onTransitionStart?: (closing: boolean) => void;
  open: boolean;
  overlayAccessibilityLabel?: string;
  overlayStyle?: StyleProp<ViewStyle>;
  renderDrawerContent: () => ReactNode;
  swipeEnabled: boolean;
  style?: StyleProp<ViewStyle>;
};
