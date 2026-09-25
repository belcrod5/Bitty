import type { ComponentProps } from "react";
import { SafeAreaView, View } from "react-native";
import { CloudflareTunnelMonitorScreen } from "../screens/CloudflareTunnelMonitorScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { SkiaMiniBoardScreen } from "../screens/SkiaMiniBoardScreen";
import type { VoiceConversationPlayback } from "../screens/VoiceConversationScreen";
import type { AppScreen } from "../types/appTypes";

type AppScreenContentProps = {
  activeScreen: AppScreen;
  onStartNewSessionInDirectory:
    ComponentProps<typeof SkiaMiniBoardScreen>["onStartNewSessionInDirectory"];
  openSessionHistoryPopup: ComponentProps<typeof SkiaMiniBoardScreen>["openSessionHistoryPopup"];
  voicePlayback: VoiceConversationPlayback;
};

export function AppScreenContent({
  activeScreen,
  onStartNewSessionInDirectory,
  openSessionHistoryPopup,
  voicePlayback,
}: AppScreenContentProps) {
  const ScreenContainer = activeScreen === "skia_board" ? View : SafeAreaView;
  return (
    <ScreenContainer style={{ flex: 1 }}>
      {activeScreen === "settings" ? (
        <SettingsScreen />
      ) : activeScreen === "cloudflare_tunnel_monitor" ? (
        <CloudflareTunnelMonitorScreen />
      ) : activeScreen === "skia_board" ? (
        <SkiaMiniBoardScreen
          onStartNewSessionInDirectory={onStartNewSessionInDirectory}
          openSessionHistoryPopup={openSessionHistoryPopup}
          voicePlayback={voicePlayback}
        />
      ) : null}
    </ScreenContainer>
  );
}
