import type { ComponentProps } from "react";
import { SafeAreaView, StyleSheet, View } from "react-native";
import { CloudflareTunnelMonitorScreen } from "../screens/CloudflareTunnelMonitorScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { SkiaMiniBoardScreen } from "../screens/SkiaMiniBoardScreen";
import type { AppScreen } from "../types/appTypes";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

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
  const { themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
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
          {activeScreen === "settings" ? (
            <SettingsScreen />
          ) : activeScreen === "cloudflare_tunnel_monitor" ? (
            <CloudflareTunnelMonitorScreen />
          ) : null}
        </SafeAreaView>
      ) : null}
    </View>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
  root: {
    flex: 1,
  },
  screen: {
    flex: 1,
    backgroundColor: theme.colors.canvas,
  },
  hiddenBoard: {
    ...StyleSheet.absoluteFillObject,
  },
  });
}

const stylesByTheme = createStylesByTheme(createStyles);
