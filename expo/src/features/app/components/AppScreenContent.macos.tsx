import type { ComponentProps } from "react";
import { SafeAreaView, StyleSheet, View } from "react-native";
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
  const boardVisible = activeScreen === "skia_board";
  return (
    <View style={styles.root}>
      <View
        accessibilityElementsHidden={!boardVisible}
        importantForAccessibility={boardVisible ? "auto" : "no-hide-descendants"}
        pointerEvents={boardVisible ? "auto" : "none"}
        style={[styles.screen, !boardVisible && styles.hiddenBoard]}
      >
        <SkiaMiniBoardScreen
          onStartNewSessionInDirectory={onStartNewSessionInDirectory}
          openSessionHistoryPopup={openSessionHistoryPopup}
        />
      </View>
      {!boardVisible ? (
        <SafeAreaView style={styles.screen}>
          {activeScreen === "debug" ? (
            <DebugScreen />
          ) : activeScreen === "cloudflare_tunnel_monitor" ? (
            <CloudflareTunnelMonitorScreen />
          ) : (
            <AudioLabScreen />
          )}
        </SafeAreaView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  screen: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  hiddenBoard: {
    ...StyleSheet.absoluteFillObject,
  },
});
