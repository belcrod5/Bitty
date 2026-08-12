import type { ComponentProps } from "react";
import { Drawer } from "react-native-drawer-layout";

type AppDrawerLayoutProps = ComponentProps<typeof Drawer>;

export function AppDrawerLayout(props: AppDrawerLayoutProps) {
  return <Drawer {...props} />;
}
