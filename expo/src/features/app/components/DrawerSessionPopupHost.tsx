import type { ReactNode } from "react";
import { SafeAreaView, View, type StyleProp, type ViewStyle } from "react-native";
import type { SessionPopupOrigin } from "./popupChatTypes";

type DrawerSessionPopupHostProps = {
  origin: SessionPopupOrigin;
  hostStyle: StyleProp<ViewStyle>;
  safeAreaStyle: StyleProp<ViewStyle>;
  children: ReactNode;
};

// セッションポップアップ(DRAWER_SESSION_POPUP_PANEL_ID)の表示ラッパー。
// ドロワー起点は従来どおりSafeArea内に収め、skiaボード起点は全画面キャンバスへ
// 直接重ねる従来のskiaポップアップと同等の見た目(SafeAreaなし)にする。
export function DrawerSessionPopupHost({
  origin,
  hostStyle,
  safeAreaStyle,
  children,
}: DrawerSessionPopupHostProps) {
  return (
    <View pointerEvents="box-none" style={hostStyle}>
      {origin === "skia_board" ? (
        children
      ) : (
        <SafeAreaView style={safeAreaStyle}>{children}</SafeAreaView>
      )}
    </View>
  );
}
