import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Animated,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import type { KeyEvent } from "react-native-macos/Libraries/Types/CoreEventTypes";
import type { AppModalProps } from "./AppModal.contract";

// React Native macOS 0.81.9の標準Modalは、表示時にFabricのcreateNode周辺で
// Exception in HostFunctionが発生するため、同じReactツリー内のoverlayで代替する。
// ライブラリ更新時に標準Modalを再検証し、解消後はこの実装を削除する。

type ModalHost = {
  remove: (id: string) => void;
  render: (id: string, entry: ModalEntry) => void;
};

type ModalEntry = {
  content: ReactNode;
  onRequestClose?: () => void;
};

const ModalHostContext = createContext<ModalHost | null>(null);
const MacOSHostView = View as ComponentType<
  ComponentProps<typeof View> & {
    keyDownEvents?: { key: string }[];
    onKeyDownCapture?: (event: KeyEvent) => void;
  }
>;

export function AppModalHost({ children }: { children: ReactNode }) {
  const [modals, setModals] = useState<Map<string, ModalEntry>>(() => new Map());
  const remove = useCallback((id: string) => {
    setModals((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  const render = useCallback((id: string, entry: ModalEntry) => {
    setModals((current) => {
      const next = new Map(current);
      next.set(id, entry);
      return next;
    });
  }, []);
  const host = useMemo(() => ({ remove, render }), [remove, render]);
  const topModal = [...modals.values()].at(-1);

  return (
    <ModalHostContext.Provider value={host}>
      <MacOSHostView
        keyDownEvents={modals.size > 0 ? [{ key: "Escape" }] : undefined}
        onKeyDownCapture={modals.size > 0 ? (event) => {
          if (event.nativeEvent.key !== "Escape") return;
          event.stopPropagation();
          topModal?.onRequestClose?.();
        } : undefined}
        style={styles.host}
      >
        {children}
        {[...modals].map(([id, entry]) => (
          <View key={id} style={StyleSheet.absoluteFill}>
            {entry.content}
          </View>
        ))}
      </MacOSHostView>
    </ModalHostContext.Provider>
  );
}

export function AppModal({
  animationType = "none",
  backdropColor,
  children,
  onDismiss,
  onRequestClose,
  onShow,
  presentationStyle: _presentationStyle,
  statusBarTranslucent: _statusBarTranslucent,
  style,
  testID,
  transparent,
  visible = true,
}: AppModalProps) {
  const host = useContext(ModalHostContext);
  const id = useId();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return;

    const animation = Animated.timing(progress, {
      duration: animationType === "none" ? 0 : 220,
      toValue: visible ? 1 : 0,
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      if (visible) {
        onShow?.();
      } else {
        setMounted(false);
        onDismiss?.();
      }
    });
    return () => animation.stop();
  }, [animationType, mounted, onDismiss, onShow, progress, visible]);

  const content = mounted ? (
    <Animated.View
      style={[
        styles.modal,
        {
          backgroundColor: transparent ? "transparent" : backdropColor || "white",
          opacity: animationType === "fade" ? progress : 1,
          top:
            animationType === "slide"
              ? progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] })
              : 0,
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </Animated.View>
  ) : null;

  useEffect(() => {
    if (!host || !content) {
      host?.remove(id);
      return;
    }
    host.render(id, { content, onRequestClose });
  }, [content, host, id, onRequestClose]);

  useEffect(() => () => host?.remove(id), [host, id]);

  if (host) return null;
  return content;
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
  modal: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
  },
});
