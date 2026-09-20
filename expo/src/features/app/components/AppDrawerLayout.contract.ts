import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { VisualThemeSoundEvent } from "../theme/visualThemes";

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
  playThemeSfx: (event: VisualThemeSoundEvent) => Promise<void>;
  renderDrawerContent: () => ReactNode;
  swipeEnabled: boolean;
  style?: StyleProp<ViewStyle>;
};
