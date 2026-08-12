import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  StyleSheet,
  View,
  useWindowDimensions,
  type ModalProps,
  type NativeSyntheticEvent,
} from "react-native";

type ModalHost = {
  remove: (id: string) => void;
  render: (id: string, content: ReactNode) => void;
};

const ModalHostContext = createContext<ModalHost | null>(null);

export function AppModalHost({ children }: { children: ReactNode }) {
  const [modals, setModals] = useState<Map<string, ReactNode>>(() => new Map());
  const remove = useCallback((id: string) => {
    setModals((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  const render = useCallback((id: string, content: ReactNode) => {
    setModals((current) => {
      const next = new Map(current);
      next.set(id, content);
      return next;
    });
  }, []);
  const host = useMemo(() => ({ remove, render }), [remove, render]);

  return (
    <ModalHostContext.Provider value={host}>
      <View style={styles.host}>
        {children}
        {[...modals].map(([id, content]) => (
          <View key={id} style={StyleSheet.absoluteFill}>
            {content}
          </View>
        ))}
      </View>
    </ModalHostContext.Provider>
  );
}

export function AppModal({
  animationType = "none",
  backdropColor,
  children,
  onDismiss,
  onShow,
  style,
  testID,
  transparent,
  visible = true,
}: ModalProps) {
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
        onShow?.({ nativeEvent: null } as NativeSyntheticEvent<null>);
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
    host.render(id, content);
  }, [content, host, id]);

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
