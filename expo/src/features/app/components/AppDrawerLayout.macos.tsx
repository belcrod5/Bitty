import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import type { AppDrawerLayoutProps } from "./AppDrawerLayout.contract";

// react-native-drawer-layout 4.2.2はmacOSでクリック領域と表示幅がずれ、
// 開閉がカクつき、閉じた領域から背面へ入力が抜けるため、このlayoutで代替する。
// ライブラリ更新時に標準Drawerを再検証し、解消後はこの実装を削除する。

const TRANSITION_DURATION_MS = 220;

export function AppDrawerLayout({
  children,
  drawerStyle,
  onClose,
  onOpen,
  onTransitionEnd,
  onTransitionStart,
  open,
  overlayAccessibilityLabel = "ナビゲーションを閉じる",
  overlayStyle,
  renderDrawerContent,
  // macOS代替layoutはedge swipeを実装しないが、開閉条件の所有者をcallerに保つため契約は共有する。
  swipeEnabled: _swipeEnabled,
  style,
}: AppDrawerLayoutProps) {
  const { width: windowWidth } = useWindowDimensions();
  const drawerWidth = Math.min(windowWidth * 0.86, 360);
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
    onTransitionStart?.(!open);
    const animation = Animated.timing(progress, {
      duration: TRANSITION_DURATION_MS,
      toValue: open ? 1 : 0,
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      if (!open) setMounted(false);
      if (open) onOpen();
      onTransitionEnd?.(!open);
    });
    return () => animation.stop();
  }, [onOpen, onTransitionEnd, onTransitionStart, open, progress]);

  return (
    <View style={[layoutStyles.root, style]}>
      {children}
      {mounted ? (
        <View style={layoutStyles.overlayLayer} testID="macos-app-drawer">
          <Animated.View
            pointerEvents="box-none"
            style={[
              StyleSheet.absoluteFill,
              { opacity: progress },
            ]}
          >
            <Pressable
              accessibilityLabel={overlayAccessibilityLabel}
              accessibilityRole="button"
              onPress={onClose}
              style={[StyleSheet.absoluteFill, overlayStyle]}
            />
          </Animated.View>
          <Animated.View
            style={[
              layoutStyles.drawer,
              { width: drawerWidth },
              drawerStyle,
              {
                left: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-drawerWidth, 0],
                }),
              },
            ]}
          >
            {renderDrawerContent()}
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

const layoutStyles = StyleSheet.create({
  root: {
    flex: 1,
  },
  overlayLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  drawer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
  },
});
