import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Drawer } from "react-native-drawer-layout";

type AppDrawerLayoutProps = ComponentProps<typeof Drawer>;

const TRANSITION_DURATION_MS = 220;

export function AppDrawerLayout({
  children,
  drawerStyle,
  onClose,
  onTransitionEnd,
  onTransitionStart,
  open,
  overlayAccessibilityLabel = "ナビゲーションを閉じる",
  overlayStyle,
  renderDrawerContent,
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
      onTransitionEnd?.(!open);
    });
    return () => animation.stop();
  }, [onTransitionEnd, onTransitionStart, open, progress]);

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
