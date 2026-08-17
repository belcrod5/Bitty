import type { ComponentProps } from "react";
import { SafeAreaView, View } from "react-native";
import { AudioLabScreen } from "./AudioLabScreen";
import { CloudflareTunnelMonitorScreen } from "../screens/CloudflareTunnelMonitorScreen";
import { DebugScreen } from "../screens/DebugScreen";
import { SkiaMiniBoardScreen } from "../screens/SkiaMiniBoardScreen";
import type { AppScreen } from "../types/appTypes";

type AppScreenContentProps = {
  activeScreen: AppScreen;
  onStartNewSessionInDirectory:
    ComponentProps<typeof SkiaMiniBoardScreen>["onStartNewSessionInDirectory"];
  openSessionHistoryPopup: ComponentProps<typeof SkiaMiniBoardScreen>["openSessionHistoryPopup"];
};

export function AppScreenContent({
  activeScreen,
  onStartNewSessionInDirectory,
  openSessionHistoryPopup,
}: AppScreenContentProps) {
  const ScreenContainer = activeScreen === "skia_board" ? View : SafeAreaView;
  return (
    <ScreenContainer style={{ flex: 1 }}>
      {activeScreen === "debug" ? (
        <DebugScreen />
      ) : activeScreen === "cloudflare_tunnel_monitor" ? (
        <CloudflareTunnelMonitorScreen />
      ) : activeScreen === "skia_board" ? (
        <SkiaMiniBoardScreen
          onStartNewSessionInDirectory={onStartNewSessionInDirectory}
          openSessionHistoryPopup={openSessionHistoryPopup}
        />
      ) : (
        <AudioLabScreen />
      )}
    </ScreenContainer>
  );
}
