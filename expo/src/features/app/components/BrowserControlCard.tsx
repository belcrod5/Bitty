import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Image, PanResponder, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { BrowserControlFrame, BrowserControlInput, BrowserControlRequest } from "../hooks/useBrowserControl";
import { BrowserControlContext } from "../contexts/BrowserControlContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { formatMessageTimestampLabel } from "../utils/formatting";

const statusText = { starting: "ブラウザに接続中…", completed: "ブラウザの操作を終了しました", cancelled: "キャンセルしました",
  expired: "接続が終了しました", invalidated: "操作開始前にページが変わりました", failed: "画面を取得できませんでした。もう一度ブラウザ操作を依頼してください。",
  control_status_unknown: "画面を確認できないため操作を停止しました。操作結果はブラウザで確認してください。" };

export function BrowserControlCard({ request }: { request: BrowserControlRequest }) {
  const controller = useContext(BrowserControlContext);
  const { theme } = useVisualTheme();
  const [opened, setOpened] = useState(false);
  const [frame, setFrame] = useState<BrowserControlFrame | null>(null);
  const [displayedId, setDisplayedId] = useState(0);
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"scroll" | "drag">("scroll");
  const draft = useRef("");
  const displayed = useRef<BrowserControlFrame | null>(null);
  const width = useRef(0);
  const latestFrame = useRef<BrowserControlFrame | null>(null);
  const previousStatus = useRef(request.status);
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const clear = useCallback(() => { latestFrame.current = null; setFrame(null); setDisplayedId(0); displayed.current = null; draft.current = ""; setValue(""); gesture.current = null; }, []);
  useEffect(() => {
    if (!opened || !controller) return;
    const stop = controller.watch(request.requestId, (next) => { if (!next) clear(); else { latestFrame.current = next; setFrame(next); } });
    if (!stop) { clear(); setOpened(false); return; }
    void controller.command(request.requestId, "start");
    return stop;
  }, [clear, controller?.command, controller?.watch, opened, request.requestId]);
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
  const flush = () => {
    if (!draft.current || !displayed.current || request.status !== "active") return;
    const text = draft.current; draft.current = ""; setValue(""); return send({ type: "text", text });
  };
  const point = (x: number, y: number) => {
    const drawn = displayed.current;
    if (!drawn || !width.current) return null;
    const height = width.current * drawn.height / drawn.width;
    return { x: Math.max(0, Math.min(1, x / width.current)), y: Math.max(0, Math.min(1, y / height)) };
  };
  const current = useRef({ send, flush, point, mode, status: request.status });
  current.current = { send, flush, point, mode, status: request.status };
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !!displayed.current && current.current.status === "active",
    onMoveShouldSetPanResponder: () => !!displayed.current && current.current.status === "active",
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      const p = current.current.point(event.nativeEvent.locationX, event.nativeEvent.locationY); if (!p) return;
      current.current.flush(); gesture.current = { ...p, moved: false };
      if (current.current.mode === "drag") current.current.send({ type: "down", ...p });
    },
    onPanResponderMove: (event) => {
      const p = current.current.point(event.nativeEvent.locationX, event.nativeEvent.locationY); const previous = gesture.current;
      if (!p || !previous) return;
      if (!previous.moved && Math.hypot(p.x - previous.x, p.y - previous.y) * width.current < 5) return;
      if (current.current.mode === "drag") current.current.send({ type: "move", ...p });
      else {
        const drawn = displayed.current!;
        current.current.send({ type: "scroll", ...p, deltaX: Math.max(-2000, Math.min(2000, (previous.x - p.x) * drawn.width)),
          deltaY: Math.max(-2000, Math.min(2000, (previous.y - p.y) * drawn.height)) });
      }
      gesture.current = { ...p, moved: true };
    },
    onPanResponderRelease: (event) => {
      const p = current.current.point(event.nativeEvent.locationX, event.nativeEvent.locationY); const previous = gesture.current;
      gesture.current = null; if (!p || !previous) return;
      if (current.current.mode === "drag") current.current.send({ type: "up", ...p });
      else if (!previous.moved) { current.current.send({ type: "down", ...p }); current.current.send({ type: "up", ...p }); }
    },
    onPanResponderTerminate: () => { const previous = gesture.current; gesture.current = null; if (previous && current.current.mode === "drag") current.current.send({ type: "up", x: previous.x, y: previous.y }); },
  })).current;
  if (!controller) return null;
  const text = { color: theme.colors.textPrimary };
  const button = (label: string, onPress: () => void, disabled = false) => <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.button}><Text style={{ color: theme.colors.controlAccent, opacity: disabled ? 0.4 : 1 }}>{label}</Text></TouchableOpacity>;
  const ready = request.status === "active" && displayedId > 0;
  return <View testID={`browser-control-${request.requestId}`} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong }]}>
    <Text style={[styles.title, text]}>ブラウザを操作 · {formatMessageTimestampLabel(request.createdAt)}</Text>
    <Text style={text}>{request.origin}</Text><Text style={text}>{request.label}</Text>
    {request.status === "pending" && !opened && <>
      <Text style={text}>画面と入力はAIへの回答・会話履歴に送信しません。</Text>
      <View style={styles.actions}>{button("キャンセル", () => { void controller.command(request.requestId, "cancel"); })}
        {button("ブラウザを開く", () => { setOpened(true); })}</View>
    </>}
    {opened && ["pending", "starting", "active"].includes(request.status) && <>
      <View testID="browser-control-screen" onLayout={(event) => { width.current = event.nativeEvent.layout.width; }}
        style={[styles.screen, { aspectRatio: frame ? frame.width / frame.height : 4 / 3, borderColor: theme.colors.borderStrong }]} {...responder.panHandlers}>
        {frame ? <Image accessibilityLabel="ブラウザの画面" source={{ uri: `data:image/jpeg;base64,${frame.data}` }} style={StyleSheet.absoluteFill}
          resizeMode="stretch" onLoad={() => { if (latestFrame.current !== frame) return; displayed.current = frame; setDisplayedId(frame.frameId); controller.ack(request.requestId, frame.frameId); }}
          onError={() => { if (latestFrame.current !== frame) return; clear(); controller.failDisplay(request.requestId, "render_failed"); }} /> : <Text style={text}>{request.status === "active" ? "画面を読み込み中…" : "ブラウザに接続中…"}</Text>}
      </View>
      <View style={styles.keys}>{button(mode === "scroll" ? "スクロール中" : "ドラッグ中", () => { setMode(mode === "scroll" ? "drag" : "scroll"); })}
        {button("Tab", () => { flush(); send({ type: "key", key: "Tab" }); }, !ready)}
        {button("⌫", () => { flush(); send({ type: "key", key: "Backspace" }); }, !ready)}
        {button("Enter", () => { flush(); send({ type: "key", key: "Enter" }); }, !ready)}
        {button("Esc", () => { flush(); send({ type: "key", key: "Escape" }); }, !ready)}
        {button("↑", () => { flush(); send({ type: "key", key: "ArrowUp" }); }, !ready)}
        {button("↓", () => { flush(); send({ type: "key", key: "ArrowDown" }); }, !ready)}
        {button("←", () => { flush(); send({ type: "key", key: "ArrowLeft" }); }, !ready)}
        {button("→", () => { flush(); send({ type: "key", key: "ArrowRight" }); }, !ready)}
      </View>
      {request.inputNotApplied && <Text style={text}>画面が変わったため文字・キーを送信しませんでした。画面を確認して再入力してください。</Text>}
      <TextInput accessibilityLabel="ブラウザへ入力するテキスト" autoCorrect={false} autoCapitalize="none" textContentType="none" autoComplete="off"
        editable={request.status === "active"} value={value} maxLength={4096} onChangeText={(next) => { draft.current = next; setValue(next); }}
        onSubmitEditing={flush} style={[styles.input, text, { borderColor: theme.colors.borderStrong }]} />
      <View style={styles.actions}>{button("入力", flush, !ready || !value)}
        {button("閉じる", () => { clear(); setOpened(false); })}
        {button("操作を完了", () => { void Promise.resolve(flush()).then(() => controller.command(request.requestId, "finish")).then(() => { clear(); setOpened(false); }); })}</View>
    </>}
    {request.status !== "pending" && request.status !== "active" && <Text style={text}>{statusText[request.status]}</Text>}
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 16, gap: 12, borderRadius: 12, borderWidth: 1, marginVertical: 8 },
  title: { fontSize: 15, fontWeight: "700" }, input: { borderWidth: 1, borderRadius: 8, padding: 12 },
  screen: { width: "100%", borderWidth: 1, justifyContent: "center", alignItems: "center", overflow: "hidden" },
  keys: { flexDirection: "row", flexWrap: "wrap", gap: 4 }, button: { paddingVertical: 8, paddingHorizontal: 6 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" } });
