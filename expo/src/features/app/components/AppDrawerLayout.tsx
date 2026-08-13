import { Drawer } from "react-native-drawer-layout";
import type { AppDrawerLayoutProps } from "./AppDrawerLayout.contract";

const DRAWER_SWIPE_EDGE_WIDTH = 48;
const DRAWER_SWIPE_MIN_DISTANCE = 28;
const DRAWER_SWIPE_MIN_VELOCITY = 280;

export function AppDrawerLayout(props: AppDrawerLayoutProps) {
  return (
    <Drawer
      {...props}
      drawerPosition="left"
      drawerType="front"
      keyboardDismissMode="on-drag"
      swipeEdgeWidth={DRAWER_SWIPE_EDGE_WIDTH}
      swipeMinDistance={DRAWER_SWIPE_MIN_DISTANCE}
      swipeMinVelocity={DRAWER_SWIPE_MIN_VELOCITY}
    />
  );
}
