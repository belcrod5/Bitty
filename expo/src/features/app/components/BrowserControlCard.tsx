import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View, type ViewProps } from "react-native";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { Gesture, GestureDetector, GestureHandlerRootView, type TouchData } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "../keyboardController";
import { AppModal } from "./AppModal";
import type { BrowserControlFocus, BrowserControlFrame, BrowserControlInput, BrowserControlRequest } from "../hooks/useBrowserControl";
import { BrowserControlContext } from "../contexts/BrowserControlContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { formatMessageTimestampLabel } from "../utils/formatting";

const statusText = { starting: "ブラウザに接続中…", completed: "ブラウザの操作を終了しました", cancelled: "キャンセルしました",
  expired: "接続が終了しました", invalidated: "操作開始前にページが変わりました", failed: "画面を取得できませんでした。もう一度ブラウザ操作を依頼してください。",
  control_status_unknown: "画面を確認できないため操作を停止しました。操作結果はブラウザで確認してください。" };

type KeyboardInput = { focusRevision: string; text?: string; key?: "Backspace" | "Enter" };
type ViewZoom = { scale: number; x: number; y: number };
type BrowserPoint = { x: number; y: number; localX: number; localY: number; touches: number; distance: number; inside: boolean };
type BrowserGesture = BrowserPoint & { moved: boolean; twoFinger: boolean; mode: "pending" | "scroll" | "pinch";
  startX: number; startY: number; startDistance: number; startZoom: ViewZoom };
function browserViewGeometry(width: number, height: number, aspectRatio: number) {
  const viewportHeight = height || width / aspectRatio;
  const fittedWidth = Math.min(width, viewportHeight * aspectRatio), fittedHeight = fittedWidth / aspectRatio;
  return { width, height: viewportHeight, fittedWidth, fittedHeight, fittedX: (width - fittedWidth) / 2, fittedY: (viewportHeight - fittedHeight) / 2 };
}
function clampViewZoom(g: ReturnType<typeof browserViewGeometry>, scale: number, left: number, top: number): ViewZoom {
  const width = g.fittedWidth * scale, height = g.fittedHeight * scale;
  return { scale,
    x: (width <= g.width ? (g.width - width) / 2 : Math.max(g.width - width, Math.min(0, left))) - g.fittedX,
    y: (height <= g.height ? (g.height - height) / 2 : Math.max(g.height - height, Math.min(0, top))) - g.fittedY };
}
const NativeKeyboard = Platform.OS === "ios" && requireOptionalNativeModule("BittyBrowserKeyboard")
  ? requireNativeViewManager<ViewProps & { focusRevision: string | null; kind: string; onInput: (event: { nativeEvent: KeyboardInput }) => void }>("BittyBrowserKeyboard") : null;

export function BrowserControlCard({ request }: { request: BrowserControlRequest }) {
  const controller = useContext(BrowserControlContext);
  const { theme } = useVisualTheme();
  const [opened, setOpened] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [frame, setFrame] = useState<BrowserControlFrame | null>(null);
  const [displayedId, setDisplayedId] = useState(0);
  const [focus, setFocus] = useState<BrowserControlFocus | null>(null);
  const latestFocus = useRef<BrowserControlFocus | null>(null);
  const updateFocus = useCallback((next: BrowserControlFocus | null) => { latestFocus.current = next; setFocus(next); }, []);
  const [keyboardAnchor, setKeyboardAnchor] = useState({ x: 0.5, y: 0.5 });
  const displayed = useRef<BrowserControlFrame | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<ViewZoom>({ scale: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  const updateZoom = useCallback((next: ViewZoom) => { zoomRef.current = next; setZoom(next); }, []);
  const latestFrame = useRef<BrowserControlFrame | null>(null);
  const imageEpoch = useRef(0);
  const previousStatus = useRef(request.status);
  const canTap = useRef(false);
  const gesture = useRef<BrowserGesture | null>(null);
  const clear = useCallback(() => { imageEpoch.current++; latestFrame.current = null; setFrame(null); setDisplayedId(0); displayed.current = null; latestFocus.current = null; setFocus(null); gesture.current = null; canTap.current = false; updateZoom({ scale: 1, x: 0, y: 0 }); }, [updateZoom]);
  useEffect(() => {
    if (!opened || !controller) return;
    const stop = controller.watch(request.requestId, (next) => {
      if (!next) { clear(); return; }
      const shown = displayed.current;
      // Native Image does not load an unchanged URI again. Already displayed pixels need no new decode.
      if (shown && latestFrame.current === shown && shown.data === next.data && shown.width === next.width && shown.height === next.height) {
        latestFrame.current = next; displayed.current = next; setDisplayedId(next.frameId);
        controller.ack(request.requestId, next.frameId); return;
      }
      if (shown && (shown.width !== next.width || shown.height !== next.height)) {
        displayed.current = null; setDisplayedId(0); gesture.current = null; canTap.current = false;
        updateZoom({ scale: 1, x: 0, y: 0 });
      }
      latestFrame.current = next; setFrame(next);
    }, updateFocus);
    if (!stop) { clear(); setOpened(false); setFullscreen(false); return; }
    void controller.command(request.requestId, "start");
    return stop;
  }, [clear, controller?.command, controller?.watch, opened, request.requestId, updateFocus, updateZoom]);
  useEffect(() => {
    const paused = request.status === "pending" && ["starting", "active"].includes(previousStatus.current);
    previousStatus.current = request.status;
    if (paused || !["pending", "starting", "active"].includes(request.status)) { clear(); setOpened(false); setFullscreen(false); }
  }, [clear, request.status]);
  const send = (input: BrowserControlInput) => {
    const drawn = displayed.current;
    if (request.status !== "active" || !drawn || !controller) return;
    return controller.input(request.requestId, input, drawn.frameId);
  };
  const aspectRatio = frame ? frame.width / frame.height : 4 / 3;
  const geometry = browserViewGeometry(viewport.width, viewport.height, aspectRatio);
  const { fittedWidth, fittedHeight, fittedX, fittedY } = geometry;
  const point = (touches: Pick<TouchData, "x" | "y">[]): BrowserPoint | null => {
    const drawn = displayed.current;
    if (!drawn || !fittedWidth || !touches.length) return null;
    const count = touches.length;
    const x = touches.reduce((sum, touch) => sum + touch.x, 0) / count;
    const y = touches.reduce((sum, touch) => sum + touch.y, 0) / count;
    const view = zoomRef.current;
    const remoteX = (x - fittedX - view.x) / (fittedWidth * view.scale);
    const remoteY = (y - fittedY - view.y) / (fittedHeight * view.scale);
    return { x: Math.max(0, Math.min(1, remoteX)), y: Math.max(0, Math.min(1, remoteY)), localX: x, localY: y, touches: count,
      distance: count >= 2 ? Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y) : 0,
      inside: remoteX >= 0 && remoteX <= 1 && remoteY >= 0 && remoteY <= 1 };
  };
  const current = useRef({ send, point, status: request.status, geometry });
  current.current = { send, point, status: request.status, geometry };
  const beginGesture = (p: BrowserPoint): BrowserGesture => ({ ...p, moved: p.touches >= 2, twoFinger: p.touches >= 2,
    mode: "pending", startX: p.localX, startY: p.localY, startDistance: p.distance, startZoom: zoomRef.current });
  const changeTouches = (p: BrowserPoint) => {
    const previous = gesture.current;
    if (!previous) return false;
    if (p.touches >= 2 && !previous.twoFinger) {
      canTap.current = false;
      if (!previous.twoFinger && previous.moved) current.current.send({ type: "up", x: previous.x, y: previous.y });
      gesture.current = beginGesture(p); return true;
    }
    if (p.touches !== previous.touches) { gesture.current = { ...previous, ...p, startX: p.localX, startY: p.localY, startDistance: p.distance, startZoom: zoomRef.current }; return true; }
    return false;
  };
  const cancelGesture = () => {
    const previous = gesture.current; gesture.current = null; canTap.current = false;
    if (previous?.moved && !previous.twoFinger) send({ type: "up", x: previous.x, y: previous.y });
  };
  const switchFullscreen = (next: boolean) => {
    cancelGesture(); imageEpoch.current++; displayed.current = null; setDisplayedId(0);
    updateZoom({ scale: 1, x: 0, y: 0 }); setViewport({ width: 0, height: 0 }); setFullscreen(next);
  };
  const ready = request.status === "active" && displayedId > 0;
  const touchGesture = useMemo(() => {
    // A native recognizer owns the touch before the enclosing chat ScrollView starts scrolling.
    const pan = Gesture.Pan().enabled(ready).minDistance(0).runOnJS(true).withTestId(`browser-control-pan-${request.requestId}`)
    .onTouchesDown((event) => {
      const p = current.current.point(event.allTouches); if (!p || current.current.status !== "active") return;
      if (gesture.current) { changeTouches(p); return; }
      if (event.numberOfTouches !== event.changedTouches.length) { canTap.current = false; return; }
      if (!p.inside) { canTap.current = false; return; }
      canTap.current = p.touches === 1;
      gesture.current = beginGesture(p);
    })
    .onTouchesMove((event) => {
      const p = current.current.point(event.allTouches); if (!p || changeTouches(p)) return;
      const previous = gesture.current;
      if (!previous || previous.twoFinger && p.touches !== 2) return;
      const drawn = displayed.current!;
      if (!previous.moved && Math.hypot(p.localX - previous.localX, p.localY - previous.localY) < 5) return;
      canTap.current = false;
      if (!previous.twoFinger) {
        if (!previous.moved) current.current.send({ type: "down", x: previous.x, y: previous.y });
        current.current.send({ type: "move", x: p.x, y: p.y });
      }
      else {
        const translation = Math.hypot(p.localX - previous.startX, p.localY - previous.startY);
        const distanceChange = Math.abs(p.distance - previous.startDistance);
        let mode = previous.mode;
        if (mode === "pending") {
          if (distanceChange >= Math.max(6, previous.startDistance * 0.08) && distanceChange > translation * 0.65) mode = "pinch";
          else if (translation >= 5) mode = "scroll";
          else return;
        }
        if (mode === "pinch") {
          const g = current.current.geometry, initial = previous.startZoom;
          const scale = Math.max(1, Math.min(6, initial.scale * p.distance / Math.max(1, previous.startDistance)));
          const left = p.localX - (previous.startX - g.fittedX - initial.x) / initial.scale * scale;
          const top = p.localY - (previous.startY - g.fittedY - initial.y) / initial.scale * scale;
          updateZoom(clampViewZoom(g, scale, left, top));
        } else {
          const g = current.current.geometry, scale = zoomRef.current.scale;
          current.current.send({ type: "scroll", x: p.x, y: p.y,
            deltaX: Math.max(-2000, Math.min(2000, (previous.localX - p.localX) / (g.fittedWidth * scale) * drawn.width)),
            deltaY: Math.max(-2000, Math.min(2000, (previous.localY - p.localY) / (g.fittedHeight * scale) * drawn.height)) });
        }
        gesture.current = { ...previous, ...p, mode, moved: true }; return;
      }
      gesture.current = { ...previous, ...p, moved: true };
    })
    .onTouchesUp((event) => {
      // iOS allTouches still contains the lifted pointers in an UP event.
      const remaining = event.allTouches.filter((touch) => !event.changedTouches.some((changed) => changed.id === touch.id));
      if (remaining.length) { const p = current.current.point(remaining); if (p) changeTouches(p); return; }
      const p = current.current.point(event.changedTouches); const previous = gesture.current;
      gesture.current = null;
      if (p && previous?.moved && !previous.twoFinger) current.current.send({ type: "up", x: p.x, y: p.y });
    })
    .onFinalize(() => { const previous = gesture.current; gesture.current = null; if (previous?.moved && !previous.twoFinger) current.current.send({ type: "up", x: previous.x, y: previous.y }); });
    // A stationary pan can fail before its raw UP arrives; native Tap owns click recognition.
    const tap = Gesture.Tap().enabled(ready).maxDistance(5).runOnJS(true).withTestId(`browser-control-tap-${request.requestId}`)
      .onEnd((event, success) => {
        if (!success || !canTap.current) return;
        canTap.current = false;
        const p = current.current.point([event]); if (!p?.inside) return;
        setKeyboardAnchor({ x: p.x, y: p.y });
        current.current.send({ type: "down", x: p.x, y: p.y }); current.current.send({ type: "up", x: p.x, y: p.y });
      }).onFinalize(() => { canTap.current = false; });
    return Gesture.Simultaneous(pan, tap);
  }, [ready, request.requestId]);
  if (!controller) return null;
  const text = { color: theme.colors.textPrimary };
  const button = (label: string, onPress: () => void, disabled = false) => <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.button}><Text style={{ color: theme.colors.controlAccent, opacity: disabled ? 0.4 : 1 }}>{label}</Text></TouchableOpacity>;
  const renderEpoch = imageEpoch.current;
  const imageLeft = fittedX + zoom.x, imageTop = fittedY + zoom.y;
  const body = <>
    <GestureDetector gesture={touchGesture}><View testID="browser-control-screen" onLayout={(event) => {
      const { width, height } = event.nativeEvent.layout;
      if (width !== viewport.width || (height || 0) !== viewport.height) {
        cancelGesture();
        const next = browserViewGeometry(width, height || 0, aspectRatio), previous = zoomRef.current;
        // Keep the same image center and scale when the keyboard or device changes the available area.
        const centerX = fittedWidth ? (geometry.width / 2 - fittedX - previous.x) / (fittedWidth * previous.scale) : 0.5;
        const centerY = fittedHeight ? (geometry.height / 2 - fittedY - previous.y) / (fittedHeight * previous.scale) : 0.5;
        updateZoom(clampViewZoom(next, previous.scale, next.width / 2 - centerX * next.fittedWidth * previous.scale,
          next.height / 2 - centerY * next.fittedHeight * previous.scale));
        setViewport({ width, height: height || 0 });
      }
    }} style={[styles.screen, fullscreen ? styles.fullscreenViewport : { aspectRatio }, { borderColor: theme.colors.borderStrong }]}>
      {frame ? <Image key={`${renderEpoch}:${frame.width}x${frame.height}`} accessibilityLabel="ブラウザの画面" source={{ uri: `data:image/jpeg;base64,${frame.data}` }}
        style={{ position: "absolute", left: imageLeft, top: imageTop, width: fittedWidth * zoom.scale, height: fittedHeight * zoom.scale }}
        resizeMode="stretch" onLoad={() => {
          if (imageEpoch.current !== renderEpoch || latestFrame.current !== frame) return;
          displayed.current = frame; setDisplayedId(frame.frameId); controller.ack(request.requestId, frame.frameId);
        }} onError={() => {
          if (imageEpoch.current !== renderEpoch || latestFrame.current !== frame) return;
          clear(); controller.failDisplay(request.requestId, "render_failed");
        }} /> : <Text style={text}>{request.status === "active" ? "画面を読み込み中…" : "ブラウザに接続中…"}</Text>}
      {NativeKeyboard && <NativeKeyboard testID="browser-control-keyboard" pointerEvents="none"
        focusRevision={ready && focus?.editable ? focus.focusRevision : null} kind={focus?.kind || "text"}
        onInput={({ nativeEvent: input }) => {
          if (imageEpoch.current !== renderEpoch || !latestFocus.current?.editable || input.focusRevision !== latestFocus.current.focusRevision) return;
          if (typeof input.text === "string" && input.text.length > 0 && input.text.length <= 4096) send({ type: "text", text: input.text, focusRevision: input.focusRevision });
          else if (input.key === "Backspace" || input.key === "Enter") send({ type: "key", key: input.key, focusRevision: input.focusRevision });
        }} style={[styles.keyboard, { left: Math.max(0, Math.min(viewport.width - 1, imageLeft + keyboardAnchor.x * fittedWidth * zoom.scale)),
          top: Math.max(0, Math.min(geometry.height - 1, imageTop + keyboardAnchor.y * fittedHeight * zoom.scale)) }]} />}
    </View></GestureDetector>
    {request.inputNotApplied && <Text style={text}>画面が変わったため文字・キーを送信しませんでした。画面を確認して再入力してください。</Text>}
    <View style={styles.actions}>
      {button(fullscreen ? "インラインに戻す" : "全画面", () => switchFullscreen(!fullscreen))}
      {button("閉じる", () => { cancelGesture(); clear(); setOpened(false); setFullscreen(false); })}
      {button("操作を完了", () => { const epoch = imageEpoch.current; void controller.command(request.requestId, "finish").then(() => {
        if (imageEpoch.current === epoch) { clear(); setOpened(false); setFullscreen(false); }
      }); })}
    </View>
  </>;
  return <View testID={`browser-control-${request.requestId}`} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong }]}>
    <Text style={[styles.title, text]}>ブラウザを操作 · {formatMessageTimestampLabel(request.createdAt)}</Text>
    <Text style={text}>{request.origin}</Text><Text style={text}>{request.label}</Text>
    {request.inputStatusUnknown && <Text style={text}>接続が切れました。前の操作結果を確認してから再開してください。</Text>}
    {request.status === "pending" && !opened && <>
      <Text style={text}>画面と入力はAIへの回答・会話履歴に送信しません。</Text>
      <View style={styles.actions}>{button("キャンセル", () => { void controller.command(request.requestId, "cancel"); })}
        {button("ブラウザを開く", () => { setOpened(true); })}</View>
    </>}
    {opened && ["pending", "starting", "active"].includes(request.status) && (fullscreen
      ? <AppModal visible presentationStyle="fullScreen" animationType="none" onRequestClose={() => switchFullscreen(false)} testID="browser-control-fullscreen">
          <GestureHandlerRootView style={styles.fullscreenRoot}>
            <SafeAreaView style={[styles.fullscreenRoot, { backgroundColor: theme.colors.surface }]} accessibilityViewIsModal>
              <KeyboardAvoidingView style={styles.fullscreenBody} behavior={Platform.OS === "ios" ? "padding" : undefined} automaticOffset={Platform.OS === "ios"}>
                <Text style={text} numberOfLines={1}>{request.origin}</Text>
                {body}
              </KeyboardAvoidingView>
            </SafeAreaView>
          </GestureHandlerRootView>
        </AppModal> : body)}
    {request.status !== "pending" && request.status !== "active" && <Text style={text}>{statusText[request.status]}</Text>}
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 16, gap: 12, borderRadius: 12, borderWidth: 1, marginVertical: 8 },
  title: { fontSize: 15, fontWeight: "700" }, keyboard: { position: "absolute", width: 1, height: 1, opacity: 0.01 },
  screen: { width: "100%", borderWidth: 1, justifyContent: "center", alignItems: "center", overflow: "hidden" },
  fullscreenRoot: { flex: 1 }, fullscreenBody: { flex: 1, padding: 12, gap: 12 }, fullscreenViewport: { flex: 1, minHeight: 0 },
  button: { paddingVertical: 8, paddingHorizontal: 6 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" } });
