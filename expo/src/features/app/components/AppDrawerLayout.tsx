import { Drawer } from "react-native-drawer-layout";
import type { AppDrawerLayoutProps } from "./AppDrawerLayout.contract";
import {
  DrawerThemeTransitionSurface,
  useDrawerTransitionEvent,
} from "./DrawerThemeTransitionSurface";

const DRAWER_SWIPE_EDGE_WIDTH = 48;
const DRAWER_SWIPE_MIN_DISTANCE = 28;
const DRAWER_SWIPE_MIN_VELOCITY = 280;

export function AppDrawerLayout(props: AppDrawerLayoutProps) {
  const { playThemeSfx, renderDrawerContent, ...drawerProps } = props;
  const transitionEvent = useDrawerTransitionEvent(props.open);

  return (
    <Drawer
      {...drawerProps}
      drawerPosition="left"
      drawerType="front"
      keyboardDismissMode="on-drag"
      renderDrawerContent={() => (
        <DrawerThemeTransitionSurface
          event={transitionEvent}
          playThemeSfx={playThemeSfx}
        >
          {renderDrawerContent()}
        </DrawerThemeTransitionSurface>
      )}
      swipeEdgeWidth={DRAWER_SWIPE_EDGE_WIDTH}
      swipeMinDistance={DRAWER_SWIPE_MIN_DISTANCE}
      swipeMinVelocity={DRAWER_SWIPE_MIN_VELOCITY}
    />
  );
}
