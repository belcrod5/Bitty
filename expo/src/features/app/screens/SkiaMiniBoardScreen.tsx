import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Canvas,
  Circle,
  Group,
  Line,
  matchFont,
  RoundedRect,
  Text as SkiaText,
  type SkFont,
} from "@shopify/react-native-skia";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  runOnJS,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useAppShell } from "../contexts/AppShellContext";
import type { SessionPopupOrigin } from "../components/popupChatTypes";
import type { LlmSessionSource } from "../hooks/useLlmSessionExplorer";
import {
  useSkiaMiniChatSessions,
  type SkiaMiniChatSession,
} from "../hooks/useSkiaMiniChatSessions";

const CARD_HEIGHT = 154;
const CARD_GAP = 18;
const BOARD_PADDING = 18;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

type CardPosition = { x: number; y: number };

// ボードステートのグリッド単位座標(col/row)と画面座標の相互変換。
// cardWidthに依存する部分をここに閉じ込め、保存値は回転などで壊れない。
function cardPositionFromGrid(col: number, row: number, cardWidth: number): CardPosition {
  return {
    x: BOARD_PADDING + col * (cardWidth + CARD_GAP),
    y: BOARD_PADDING + row * (CARD_HEIGHT + CARD_GAP),
  };
}

function gridFromCardPosition(x: number, y: number, cardWidth: number) {
  return {
    col: (x - BOARD_PADDING) / (cardWidth + CARD_GAP),
    row: (y - BOARD_PADDING) / (CARD_HEIGHT + CARD_GAP),
  };
}

function fitText(text: string, font: SkFont, maxWidth: number) {
  if (font.getTextWidth(text) <= maxWidth) return text;
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (font.getTextWidth(`${characters.slice(0, middle).join("")}…`) <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, low).join("")}…`;
}

function markerColor(color: SkiaMiniChatSession["markerColor"]) {
  if (color === "red") return "#ef4444";
  if (color === "yellow") return "#eab308";
  if (color === "green") return "#22c55e";
  if (color === "black") return "#111827";
  if (color === "gray") return "#94a3b8";
  return "#cbd5e1";
}

type MiniChatCardProps = {
  cardWidth: number;
  index: number;
  positions: SharedValue<CardPosition[]>;
  session: SkiaMiniChatSession;
  selected: boolean;
  titleFont: SkFont;
  bodyFont: SkFont;
};

function MiniChatCard({
  cardWidth,
  index,
  positions,
  session,
  selected,
  titleFont,
  bodyFont,
}: MiniChatCardProps) {
  const transform = useDerivedValue(() => {
    const position = positions.value[index] || { x: 0, y: 0 };
    return [{ translateX: position.x }, { translateY: position.y }];
  });
  const contentWidth = cardWidth - 32;

  return (
    <Group transform={transform}>
      <RoundedRect x={2} y={4} width={cardWidth} height={CARD_HEIGHT} r={14} color="#cbd5e1" opacity={0.42} />
      <RoundedRect x={0} y={0} width={cardWidth} height={CARD_HEIGHT} r={14} color="#ffffff" />
      <RoundedRect
        x={0}
        y={0}
        width={cardWidth}
        height={CARD_HEIGHT}
        r={14}
        color={selected ? "#2563eb" : "#d7dee8"}
        style="stroke"
        strokeWidth={selected ? 2.5 : 1}
      />
      <Group clip={{ x: 10, y: 8, width: cardWidth - 20, height: CARD_HEIGHT - 16 }}>
        <Circle cx={18} cy={21} r={5} color={markerColor(session.markerColor)} />
        <SkiaText
          x={31}
          y={25}
          text={fitText(session.directoryName, bodyFont, cardWidth - 47)}
          font={bodyFont}
          color="#64748b"
        />
        <SkiaText
          x={16}
          y={55}
          text={fitText(session.title, titleFont, contentWidth)}
          font={titleFont}
          color="#172033"
        />
        <SkiaText
          x={16}
          y={83}
          text={fitText(session.lastMessageContent || "メッセージを読み込み中…", bodyFont, contentWidth)}
          font={bodyFont}
          color="#64748b"
        />
        <Line p1={{ x: 16, y: 105 }} p2={{ x: cardWidth - 16, y: 105 }} color="#e2e8f0" strokeWidth={1} />
        <SkiaText x={16} y={129} text={session.updatedAtLabel} font={bodyFont} color="#64748b" />
      </Group>
    </Group>
  );
}

type SkiaMiniBoardScreenProps = {
  openSessionHistoryPopup: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory?: string;
    origin?: SessionPopupOrigin;
  }) => void;
};

export function SkiaMiniBoardScreen({ openSessionHistoryPopup }: SkiaMiniBoardScreenProps) {
  const { width: windowWidth } = useWindowDimensions();
  const { openDrawer } = useAppShell();
  const {
    directorySync,
    hydratingPanelCount,
    panelHydrationErrorCount,
    sessions,
    moveBoardCard,
    removeBoardSession,
    tidyBoard,
  } = useSkiaMiniChatSessions();
  const syncStatusText =
    directorySync.phase === "loading"
      ? `同期中 ${directorySync.completedCount}/${directorySync.totalCount}`
      : directorySync.phase === "refreshing"
        ? `更新中 ${directorySync.completedCount}/${directorySync.totalCount}`
        : directorySync.phase === "error"
          ? `セッション同期失敗 ${directorySync.failedCount}/${directorySync.totalCount}`
          : hydratingPanelCount > 0
            ? `チャット読込中 ${hydratingPanelCount}件`
            : panelHydrationErrorCount > 0
              ? `${sessions.length}件を表示・${panelHydrationErrorCount}件の読込失敗`
              : directorySync.phase === "partial_error"
                ? `${sessions.length}件を表示・一部更新失敗`
                : `${sessions.length}件を表示`;
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [viewportWidth, setViewportWidth] = useState(windowWidth);
  const cardWidth = Math.max(150, Math.min(270, (viewportWidth - BOARD_PADDING * 2 - CARD_GAP) / 2));
  const positions = useSharedValue<CardPosition[]>([]);
  const boardX = useSharedValue(0);
  const boardY = useSharedValue(0);
  const scale = useSharedValue(1);
  const gestureStartX = useSharedValue(0);
  const gestureStartY = useSharedValue(0);
  const gestureStartScale = useSharedValue(1);
  const pinchBoardX = useSharedValue(0);
  const pinchBoardY = useSharedValue(0);
  const activeCardIndex = useSharedValue(-1);
  const activeCardSessionId = useSharedValue("");
  const activeCardX = useSharedValue(0);
  const activeCardY = useSharedValue(0);
  const selectedCardIndex = useSharedValue(-1);
  const touchSequenceHadMultiplePointers = useSharedValue(false);

  const fontFamily = Platform.select({ ios: "Hiragino Sans", android: "sans-serif", default: "Arial" });
  const titleFont = useMemo(() => matchFont({ fontFamily, fontSize: 13, fontWeight: "bold" }), [fontFamily]);
  const bodyFont = useMemo(() => matchFont({ fontFamily, fontSize: 10 }), [fontFamily]);

  // ボードステート(col/row)から画面座標を再構築する。ドラッグ中はSharedValueのみが
  // 動き、ドラッグ終了時のcommitでステートへ反映されるため、同値の再適用になる。
  const positionsKey = useMemo(() => (
    sessions.map((session) => `${session.sessionId}:${session.col}:${session.row}`).join("|")
  ), [sessions]);
  // 描画前(useLayoutEffect)に反映し、原点に一瞬固まって見えるフレームを避ける。
  const appliedPositionsKeyRef = useRef("");
  useLayoutEffect(() => {
    const key = `${cardWidth}|${positionsKey}`;
    if (appliedPositionsKeyRef.current === key) return;
    appliedPositionsKeyRef.current = key;
    positions.value = sessions.map((session) => (
      cardPositionFromGrid(session.col, session.row, cardWidth)
    ));
  }, [cardWidth, positions, positionsKey, sessions]);

  // カードの並び(搭載セッション)が変わったら、indexベースの選択をクリアする。
  const sessionIdsKey = useMemo(() => (
    sessions.map((session) => session.sessionId).join("|")
  ), [sessions]);
  useEffect(() => {
    selectedCardIndex.value = -1;
    setSelectedSessionId("");
  }, [selectedCardIndex, sessionIdsKey]);

  const handleCardTap = useCallback((index: number) => {
    if (index < 0) {
      selectedCardIndex.value = -1;
      setSelectedSessionId("");
      return;
    }
    const session = sessions[index];
    if (!session) return;
    if (selectedSessionId === session.sessionId) {
      // プレビュー用パネルは直接開かず、ドロワーと同じ専用パネルのポップアップで開く
      // (毎オープン時にJSONLからhydrateされ、常に最新の本文になる)。
      openSessionHistoryPopup({
        sessionId: session.sessionId,
        directory: session.directory,
        source: session.source,
        origin: "skia_board",
      });
      return;
    }
    selectedCardIndex.value = index;
    setSelectedSessionId(session.sessionId);
  }, [openSessionHistoryPopup, selectedCardIndex, selectedSessionId, sessions]);

  // ドラッグ終了時に画面座標をグリッド単位へ戻してボードステートへ保存する。
  // ドラッグ中に候補が増減してindexがずれても別セッションを上書きしないよう、
  // 対象と座標はドラッグ開始時のカードに紐づけ、候補の増減後もindexから引き直さない。
  const commitCardPosition = useCallback((sessionId: string, x: number, y: number) => {
    if (!sessionId) return;
    const grid = gridFromCardPosition(x, y, cardWidth);
    moveBoardCard(sessionId, grid.col, grid.row);
  }, [cardWidth, moveBoardCard]);

  const confirmRemoveCard = useCallback((index: number) => {
    const session = sessions[index];
    if (!session) return;
    Alert.alert(
      "カードを削除",
      `「${session.title || session.sessionId}」をボードから外しますか?\n外したセッションは自動では再追加されません。`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: () => removeBoardSession(session.sessionId),
        },
      ]
    );
  }, [removeBoardSession, sessions]);

  const boardTranslate = useDerivedValue(() => [
    { translateX: boardX.value },
    { translateY: boardY.value },
  ]);
  const boardScale = useDerivedValue(() => [{ scale: scale.value }]);

  const gestures = useMemo(() => {
    // worklet内でindex→sessionIdを引くための軽量スナップショット(文字列のみ)。
    const sessionIds = sessions.map((session) => session.sessionId);
    const drag = Gesture.Pan()
      .maxPointers(2)
      .onTouchesDown((event) => {
        if (event.numberOfTouches === 1) {
          touchSequenceHadMultiplePointers.value = false;
        } else if (event.numberOfTouches > 1) {
          touchSequenceHadMultiplePointers.value = true;
        }
      })
      .onBegin((event) => {
        const x = (event.x - boardX.value) / scale.value;
        const y = (event.y - boardY.value) / scale.value;
        activeCardIndex.value = -1;
        activeCardSessionId.value = "";

        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          const position = positions.value[index];
          if (
            position
            && x >= position.x
            && x <= position.x + cardWidth
            && y >= position.y
            && y <= position.y + CARD_HEIGHT
          ) {
            if (selectedCardIndex.value === index) {
              activeCardIndex.value = index;
              activeCardSessionId.value = sessionIds[index] || "";
              gestureStartX.value = position.x;
              gestureStartY.value = position.y;
              activeCardX.value = position.x;
              activeCardY.value = position.y;
            } else {
              gestureStartX.value = boardX.value;
              gestureStartY.value = boardY.value;
            }
            return;
          }
        }

        gestureStartX.value = boardX.value;
        gestureStartY.value = boardY.value;
      })
      .onUpdate((event) => {
        if (event.numberOfPointers > 1) {
          touchSequenceHadMultiplePointers.value = true;
        }
        if (touchSequenceHadMultiplePointers.value) return;
        const index = activeCardIndex.value;
        if (index >= 0) {
          const nextX = gestureStartX.value + event.translationX / scale.value;
          const nextY = gestureStartY.value + event.translationY / scale.value;
          const nextPositions = positions.value.slice();
          nextPositions[index] = {
            x: nextX,
            y: nextY,
          };
          activeCardX.value = nextX;
          activeCardY.value = nextY;
          positions.value = nextPositions;
          return;
        }
        boardX.value = gestureStartX.value + event.translationX;
        boardY.value = gestureStartY.value + event.translationY;
      })
      .onFinalize(() => {
        const index = activeCardIndex.value;
        const sessionId = activeCardSessionId.value;
        const x = activeCardX.value;
        const y = activeCardY.value;
        activeCardIndex.value = -1;
        activeCardSessionId.value = "";
        if (index < 0 || !sessionId) return;
        runOnJS(commitCardPosition)(sessionId, x, y);
      });

    const tap = Gesture.Tap()
      .maxDistance(8)
      .onEnd((event, success) => {
        if (!success || touchSequenceHadMultiplePointers.value) return;
        const x = (event.x - boardX.value) / scale.value;
        const y = (event.y - boardY.value) / scale.value;
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          const position = positions.value[index];
          if (
            position
            && x >= position.x
            && x <= position.x + cardWidth
            && y >= position.y
            && y <= position.y + CARD_HEIGHT
          ) {
            runOnJS(handleCardTap)(index);
            return;
          }
        }
        runOnJS(handleCardTap)(-1);
      });

    // カード長押しで削除確認(OKでボードから外し、除外リストへ)。
    // 選択済みカードの保持はドラッグ意図(activeCardIndex>=0)なので発火させない。
    const longPress = Gesture.LongPress()
      .minDuration(500)
      .onStart((event) => {
        if (touchSequenceHadMultiplePointers.value) return;
        if (activeCardIndex.value >= 0) return;
        const x = (event.x - boardX.value) / scale.value;
        const y = (event.y - boardY.value) / scale.value;
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          const position = positions.value[index];
          if (
            position
            && x >= position.x
            && x <= position.x + cardWidth
            && y >= position.y
            && y <= position.y + CARD_HEIGHT
          ) {
            runOnJS(confirmRemoveCard)(index);
            return;
          }
        }
      });

    const pinch = Gesture.Pinch()
      .onBegin(() => {
        touchSequenceHadMultiplePointers.value = true;
      })
      .onStart((event) => {
        gestureStartScale.value = scale.value;
        pinchBoardX.value = (event.focalX - boardX.value) / scale.value;
        pinchBoardY.value = (event.focalY - boardY.value) / scale.value;
      })
      .onUpdate((event) => {
        if (event.numberOfPointers < 2) return;
        const nextScale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, gestureStartScale.value * event.scale)
        );
        scale.value = nextScale;
        boardX.value = event.focalX - pinchBoardX.value * nextScale;
        boardY.value = event.focalY - pinchBoardY.value * nextScale;
      });

    return Gesture.Simultaneous(drag, pinch, tap, longPress);
  }, [
    activeCardIndex,
    activeCardSessionId,
    activeCardX,
    activeCardY,
    boardX,
    boardY,
    cardWidth,
    commitCardPosition,
    confirmRemoveCard,
    gestureStartScale,
    gestureStartX,
    gestureStartY,
    handleCardTap,
    pinchBoardX,
    pinchBoardY,
    positions,
    scale,
    selectedCardIndex,
    sessions,
    touchSequenceHadMultiplePointers,
  ]);

  // カード位置には触らず、パン・ズームだけを初期化する(整頓ボタンとの差別化)。
  const resetViewport = () => {
    boardX.value = 0;
    boardY.value = 0;
    scale.value = 1;
    selectedCardIndex.value = -1;
    setSelectedSessionId("");
  };

  const gridLines = useMemo(() => {
    const lines: Array<{ key: string; p1: { x: number; y: number }; p2: { x: number; y: number } }> = [];
    for (let x = 0; x <= 900; x += 40) {
      lines.push({ key: `x-${x}`, p1: { x, y: 0 }, p2: { x, y: 900 } });
    }
    for (let y = 0; y <= 900; y += 40) {
      lines.push({ key: `y-${y}`, p1: { x: 0, y }, p2: { x: 900, y } });
    }
    return lines;
  }, []);

  return (
    <View style={screenStyles.screen}>
      <View style={screenStyles.header}>
        <TouchableOpacity style={screenStyles.headerButton} onPress={openDrawer}>
          <Text style={screenStyles.headerButtonText}>☰</Text>
        </TouchableOpacity>
        <View style={screenStyles.headerTitleBlock}>
          <Text style={screenStyles.headerTitle}>Board</Text>
          <Text style={screenStyles.headerSubtitle}>タップで選択・再タップで開く・選択後にドラッグ・長押しで削除</Text>
        </View>
        <TouchableOpacity
          style={screenStyles.headerActionButton}
          onPress={tidyBoard}
          accessibilityRole="button"
          accessibilityLabel="カードをグリッドに整頓"
        >
          <Ionicons name="grid-outline" size={16} color="#334155" />
        </TouchableOpacity>
        <TouchableOpacity style={screenStyles.resetButton} onPress={resetViewport}>
          <Text style={screenStyles.resetButtonText}>Reset</Text>
        </TouchableOpacity>
      </View>

      <GestureDetector gesture={gestures}>
        <View
          style={screenStyles.canvasHost}
          onLayout={(event) => {
            setViewportWidth(event.nativeEvent.layout.width);
          }}
        >
          <Canvas style={StyleSheet.absoluteFill}>
            <Group transform={boardTranslate}>
              <Group transform={boardScale}>
                {gridLines.map((line) => (
                  <Line key={line.key} p1={line.p1} p2={line.p2} color="#dce4ed" strokeWidth={1} />
                ))}
                {sessions.map((session, index) => (
                  <MiniChatCard
                    key={session.sessionId}
                    cardWidth={cardWidth}
                    index={index}
                    positions={positions}
                    session={session}
                    selected={session.sessionId === selectedSessionId}
                    titleFont={titleFont}
                    bodyFont={bodyFont}
                  />
                ))}
              </Group>
            </Group>
          </Canvas>
        </View>
      </GestureDetector>

      <View pointerEvents="none" style={screenStyles.statusPill}>
        <Text style={screenStyles.statusText}>
          {syncStatusText}
        </Text>
      </View>
    </View>
  );
}

const screenStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#eef2f7",
  },
  header: {
    minHeight: 62,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#ffffff",
    borderBottomColor: "#d8e0ea",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e8eef6",
  },
  headerButtonText: {
    color: "#27364b",
    fontSize: 20,
    fontWeight: "700",
  },
  headerTitleBlock: {
    flex: 1,
  },
  headerTitle: {
    color: "#172033",
    fontSize: 16,
    fontWeight: "800",
  },
  headerSubtitle: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 2,
  },
  headerActionButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e8eef6",
  },
  resetButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#e8eef6",
  },
  resetButtonText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "700",
  },
  canvasHost: {
    flex: 1,
    overflow: "hidden",
  },
  statusPill: {
    position: "absolute",
    left: 14,
    bottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: "rgba(23, 32, 51, 0.84)",
  },
  statusText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
  },
});
