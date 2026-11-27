import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, StyleSheet, Text, TouchableOpacity, View, type ViewProps } from "react-native";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { Gesture, GestureDetector, type TouchData } from "react-native-gesture-handler";
import type { BrowserControlFocus, BrowserControlFrame, BrowserControlInput, BrowserControlRequest } from "../hooks/useBrowserControl";
import { BrowserControlContext } from "../contexts/BrowserControlContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { formatMessageTimestampLabel } from "../utils/formatting";

const statusText = { starting: "ブラウザに接続中…", completed: "ブラウザの操作を終了しました", cancelled: "キャンセルしました",
  expired: "接続が終了しました", invalidated: "操作開始前にページが変わりました", failed: "画面を取得できませんでした。もう一度ブラウザ操作を依頼してください。",
  control_status_unknown: "画面を確認できないため操作を停止しました。操作結果はブラウザで確認してください。" };

type KeyboardInput = { focusRevision: string; text?: string; key?: "Backspace" | "Enter" };
const NativeKeyboard = Platform.OS === "ios" && requireOptionalNativeModule("BittyBrowserKeyboard")
  ? requireNativeViewManager<ViewProps & { focusRevision: string | null; kind: string; onInput: (event: { nativeEvent: KeyboardInput }) => void }>("BittyBrowserKeyboard") : null;

export function BrowserControlCard({ request }: { request: BrowserControlRequest }) {
  const controller = useContext(BrowserControlContext);
  const { theme } = useVisualTheme();
  const [opened, setOpened] = useState(false);
  const [frame, setFrame] = useState<BrowserControlFrame | null>(null);
  const [displayedId, setDisplayedId] = useState(0);
  const [focus, setFocus] = useState<BrowserControlFocus | null>(null);
  const latestFocus = useRef<BrowserControlFocus | null>(null);
  const updateFocus = useCallback((next: BrowserControlFocus | null) => { latestFocus.current = next; setFocus(next); }, []);
  const [keyboardAnchor, setKeyboardAnchor] = useState({ x: 0.5, y: 0.5 });
  const displayed = useRef<BrowserControlFrame | null>(null);
  const width = useRef(0);
  const latestFrame = useRef<BrowserControlFrame | null>(null);
  const imageEpoch = useRef(0);
  const previousStatus = useRef(request.status);
  const canTap = useRef(false);
  const gesture = useRef<{ x: number; y: number; touches: number; moved: boolean; twoFinger: boolean } | null>(null);
  const clear = useCallback(() => { imageEpoch.current++; latestFrame.current = null; setFrame(null); setDisplayedId(0); displayed.current = null; latestFocus.current = null; setFocus(null); gesture.current = null; canTap.current = false; }, []);
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
      }
      latestFrame.current = next; setFrame(next);
    }, updateFocus);
    if (!stop) { clear(); setOpened(false); return; }
    void controller.command(request.requestId, "start");
    return stop;
  }, [clear, controller?.command, controller?.watch, opened, request.requestId, updateFocus]);
  useEffect(() => {
    const paused = request.status === "pending" && ["starting", "active"].includes(previousStatus.current);
    previousStatus.current = request.status;
    if (paused || !["pending", "starting", "active"].includes(request.status)) { clear(); setOpened(false); }
  }, [clear, request.status]);
  const send = (input: BrowserControlInput) => {
    const drawn = displayed.current;
    if (request.status !== "active" || !drawn || !controller) return;
    return controller.input(request.requestId, input, drawn.frameId);
  };
  const point = (touches: Pick<TouchData, "x" | "y">[]) => {
    const drawn = displayed.current;
    if (!drawn || !width.current || !touches.length) return null;
    const count = touches.length;
    const x = touches.reduce((sum, touch) => sum + touch.x, 0) / count;
    const y = touches.reduce((sum, touch) => sum + touch.y, 0) / count;
    const height = width.current * drawn.height / drawn.width;
    return { x: Math.max(0, Math.min(1, x / width.current)), y: Math.max(0, Math.min(1, y / height)), touches: count };
  };
  const current = useRef({ send, point, status: request.status });
  current.current = { send, point, status: request.status };
  const changeTouches = (p: { x: number; y: number; touches: number }) => {
    const previous = gesture.current;
    if (!previous) return false;
    if (p.touches >= 2 && !previous.twoFinger) {
      canTap.current = false;
      if (!previous.twoFinger && previous.moved) current.current.send({ type: "up", x: previous.x, y: previous.y });
      gesture.current = { ...p, moved: true, twoFinger: true }; return true;
    }
    if (p.touches !== previous.touches) { gesture.current = { ...previous, ...p }; return true; }
    return false;
  };
  const ready = request.status === "active" && displayedId > 0;
  const touchGesture = useMemo(() => {
    // A native recognizer owns the touch before the enclosing chat ScrollView starts scrolling.
    const pan = Gesture.Pan().enabled(ready).minDistance(0).runOnJS(true).withTestId(`browser-control-pan-${request.requestId}`)
    .onTouchesDown((event) => {
      const p = current.current.point(event.allTouches); if (!p || current.current.status !== "active") return;
      if (gesture.current) { changeTouches(p); return; }
      if (event.numberOfTouches !== event.changedTouches.length) { canTap.current = false; return; }
      const twoFinger = p.touches >= 2;
      canTap.current = !twoFinger;
      gesture.current = { ...p, moved: twoFinger, twoFinger };
    })
    .onTouchesMove((event) => {
      const p = current.current.point(event.allTouches); if (!p || changeTouches(p)) return;
      const previous = gesture.current;
      if (!previous || previous.twoFinger && p.touches < 2) return;
      const drawn = displayed.current!;
      if (!previous.moved && Math.hypot((p.x - previous.x) * width.current, (p.y - previous.y) * width.current * drawn.height / drawn.width) < 5) return;
      canTap.current = false;
      if (!previous.twoFinger) {
        if (!previous.moved) current.current.send({ type: "down", x: previous.x, y: previous.y });
        current.current.send({ type: "move", x: p.x, y: p.y });
      }
      else {
        current.current.send({ type: "scroll", x: p.x, y: p.y, deltaX: Math.max(-2000, Math.min(2000, (previous.x - p.x) * drawn.width)),
          deltaY: Math.max(-2000, Math.min(2000, (previous.y - p.y) * drawn.height)) });
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
        const p = current.current.point([event]); if (!p) return;
        setKeyboardAnchor({ x: p.x, y: p.y });
        current.current.send({ type: "down", x: p.x, y: p.y }); current.current.send({ type: "up", x: p.x, y: p.y });
      }).onFinalize(() => { canTap.current = false; });
    return Gesture.Simultaneous(pan, tap);
  }, [ready, request.requestId]);
  if (!controller) return null;
  const text = { color: theme.colors.textPrimary };
  const button = (label: string, onPress: () => void, disabled = false) => <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.button}><Text style={{ color: theme.colors.controlAccent, opacity: disabled ? 0.4 : 1 }}>{label}</Text></TouchableOpacity>;
  return <View testID={`browser-control-${request.requestId}`} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong }]}>
    <Text style={[styles.title, text]}>ブラウザを操作 · {formatMessageTimestampLabel(request.createdAt)}</Text>
    <Text style={text}>{request.origin}</Text><Text style={text}>{request.label}</Text>
    {request.inputStatusUnknown && <Text style={text}>接続が切れました。前の操作結果を確認してから再開してください。</Text>}
    {request.status === "pending" && !opened && <>
      <Text style={text}>画面と入力はAIへの回答・会話履歴に送信しません。</Text>
      <View style={styles.actions}>{button("キャンセル", () => { void controller.command(request.requestId, "cancel"); })}
        {button("ブラウザを開く", () => { setOpened(true); })}</View>
    </>}
    {opened && ["pending", "starting", "active"].includes(request.status) && <>
      <GestureDetector gesture={touchGesture}><View testID="browser-control-screen" onLayout={(event) => { width.current = event.nativeEvent.layout.width; }}
        style={[styles.screen, { aspectRatio: frame ? frame.width / frame.height : 4 / 3, borderColor: theme.colors.borderStrong }]}>
        {frame ? <Image key={`${imageEpoch.current}:${frame.width}x${frame.height}`} accessibilityLabel="ブラウザの画面" source={{ uri: `data:image/jpeg;base64,${frame.data}` }} style={StyleSheet.absoluteFill}
          resizeMode="stretch" onLoad={() => { if (latestFrame.current !== frame) return; displayed.current = frame; setDisplayedId(frame.frameId); controller.ack(request.requestId, frame.frameId); }}
          onError={() => { if (latestFrame.current !== frame) return; clear(); controller.failDisplay(request.requestId, "render_failed"); }} /> : <Text style={text}>{request.status === "active" ? "画面を読み込み中…" : "ブラウザに接続中…"}</Text>}
        {NativeKeyboard && <NativeKeyboard testID="browser-control-keyboard" pointerEvents="none"
          focusRevision={ready && focus?.editable ? focus.focusRevision : null} kind={focus?.kind || "text"}
          onInput={({ nativeEvent: input }) => {
            if (!latestFocus.current?.editable || input.focusRevision !== latestFocus.current.focusRevision) return;
            if (typeof input.text === "string" && input.text.length > 0 && input.text.length <= 4096) send({ type: "text", text: input.text, focusRevision: input.focusRevision });
            else if (input.key === "Backspace" || input.key === "Enter") send({ type: "key", key: input.key, focusRevision: input.focusRevision });
          }} style={[styles.keyboard, { left: `${keyboardAnchor.x * 100}%`, top: `${keyboardAnchor.y * 100}%` }]} />}
      </View></GestureDetector>
      {request.inputNotApplied && <Text style={text}>画面が変わったため文字・キーを送信しませんでした。画面を確認して再入力してください。</Text>}
      <View style={styles.actions}>{button("閉じる", () => { clear(); setOpened(false); })}
        {button("操作を完了", () => { const epoch = imageEpoch.current; void controller.command(request.requestId, "finish").then(() => { if (imageEpoch.current === epoch) { clear(); setOpened(false); } }); })}</View>
    </>}
    {request.status !== "pending" && request.status !== "active" && <Text style={text}>{statusText[request.status]}</Text>}
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 16, gap: 12, borderRadius: 12, borderWidth: 1, marginVertical: 8 },
  title: { fontSize: 15, fontWeight: "700" }, keyboard: { position: "absolute", width: 1, height: 1, opacity: 0.01 },
  screen: { width: "100%", borderWidth: 1, justifyContent: "center", alignItems: "center", overflow: "hidden" },
  button: { paddingVertical: 8, paddingHorizontal: 6 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" } });
