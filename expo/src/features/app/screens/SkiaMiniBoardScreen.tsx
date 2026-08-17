import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
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
  FontWeight,
  Group,
  Line,
  Paragraph,
  Path,
  RoundedRect,
  Skia,
} from "@shopify/react-native-skia";
import { collectGraphemes } from "unicode-segmenter/grapheme";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  Easing,
  runOnJS,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useAppShell } from "../contexts/AppShellContext";
import { useChatScreen } from "../contexts/ChatScreenContext";
import type { SessionPopupOrigin } from "../components/popupChatTypes";
import type { LlmSessionSource } from "../hooks/useLlmSessionExplorer";
import {
  useSkiaMiniChatSessions,
  type SkiaMiniBoardItem,
  type SkiaMiniChatSession,
} from "../hooks/useSkiaMiniChatSessions";
import {
  normalizeRunnerPath,
  openRunnerFile,
  openRunnerFileContextMenu,
  type RunnerFileViewerTarget,
  type RunnerMediaFile,
} from "../utils/runnerFileContextMenu";
import { useWorkspaceFileMutations } from "../hooks/useWorkspaceFileMutations";
import { RunnerMediaViewer } from "../components/RunnerMediaViewer";
import { RunnerFileViewer } from "../components/RunnerFileViewer";
import { WorkspaceFileRenameDialog } from "../components/WorkspaceFileRenameDialog";
import { WorkspaceTextFileEditor } from "../components/WorkspaceTextFileEditor";
import { AppModal } from "../components/AppModal";
import {
  SkiaBoardSectionDraft,
  SkiaBoardSectionOverlay,
  SkiaBoardSectionRegion,
} from "../components/SkiaBoardSection";
import { SkiaBoardSectionEditor } from "../components/SkiaBoardSectionEditor";
import type { WorkspaceFileTarget } from "../utils/workspaceFiles";
import {
  SKIA_BOARD_MAX_TEXT_SCALE,
  SKIA_BOARD_MIN_TEXT_SCALE,
  SKIA_BOARD_TEXT_SCALE_STEP,
} from "../utils/skiaBoardState";
import {
  cardPositionFromGrid,
  gridFromCardPosition,
  gridFromSectionRect,
  pointIsInsideSection,
  sectionRectFromGrid,
  sectionDragActionAtPoint,
  sectionRectFromPoints,
  SKIA_BOARD_CARD_GAP as CARD_GAP,
  SKIA_BOARD_CARD_HEIGHT as CARD_HEIGHT,
  SKIA_BOARD_MIN_SECTION_SIZE,
  SKIA_BOARD_MIN_CARD_WIDTH,
  SKIA_BOARD_PADDING as BOARD_PADDING,
  transformSectionRect,
  type SkiaBoardSectionDragAction,
  type SkiaBoardSectionRect,
} from "../utils/skiaBoardSectionGeometry";

const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const ZOOM_ANIMATION = {
  duration: 100,
  easing: Easing.out(Easing.cubic),
};

// SkiaのTextは1つのtypefaceだけを使うため、日本語や絵文字へフォールバックできない。
// ParagraphにシステムのFontMgrを使わせ、Appleプラットフォーム共通のfallbackを有効にする。
const BOARD_FONT_FAMILIES = Platform.select({
  android: ["sans-serif"],
  default: [".AppleSystemUIFont"],
});

type BoardTextStyle = {
  color: string;
  fontSize: number;
  bold?: boolean;
};

function createBoardParagraph(
  text: string,
  width: number,
  style: BoardTextStyle
) {
  const builder = Skia.ParagraphBuilder.Make({ maxLines: 1, ellipsis: "…" });
  builder.pushStyle({
    color: Skia.Color(style.color),
    fontFamilies: BOARD_FONT_FAMILIES,
    fontSize: style.fontSize,
    ...(style.bold ? { fontStyle: { weight: FontWeight.Bold } } : {}),
  });
  builder.addText(text);
  const paragraph = builder.build();
  paragraph.layout(width);
  return paragraph;
}

function BoardText({
  x,
  y,
  width,
  text,
  color,
  fontSize,
  bold,
}: BoardTextStyle & { x: number; y: number; width: number; text: string }) {
  const paragraph = useMemo(
    () => createBoardParagraph(text, width, { color, fontSize, bold }),
    [bold, color, fontSize, text, width]
  );
  return <Paragraph x={x} y={y} width={width} paragraph={paragraph} />;
}

function paragraphTextWidth(text: string, fontSize: number) {
  const paragraph = createBoardParagraph(text, 100_000, { color: "#000000", fontSize });
  try {
    return paragraph.getLongestLine();
  } finally {
    paragraph.dispose();
  }
}
const DEFAULT_SECTION_COLOR = "#3b82f6";

type CardPosition = { x: number; y: number };
type ActiveSectionGesture = {
  index: number;
  sectionId: string;
  action: SkiaBoardSectionDragAction | "create" | "blocked" | "";
  start: SkiaBoardSectionRect;
  current: SkiaBoardSectionRect;
};
const EMPTY_SECTION_RECT: SkiaBoardSectionRect = {
  id: "",
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};
const EMPTY_ACTIVE_SECTION_GESTURE: ActiveSectionGesture = {
  index: -1,
  sectionId: "",
  action: "",
  start: EMPTY_SECTION_RECT,
  current: EMPTY_SECTION_RECT,
};
const EMPTY_DRAFT_SECTION: SkiaBoardSectionRect = { ...EMPTY_SECTION_RECT, id: "draft" };

function fittingPrefixEnd(
  characters: readonly string[],
  start: number,
  end: number,
  font: { getTextWidth: (text: string) => number },
  maxWidth: number,
  suffix = ""
) {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (font.getTextWidth(`${characters.slice(start, middle).join("")}${suffix}`) <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function fittingSuffixStart(
  characters: readonly string[],
  start: number,
  end: number,
  font: { getTextWidth: (text: string) => number },
  maxWidth: number,
  prefix = ""
) {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (font.getTextWidth(`${prefix}${characters.slice(middle, end).join("")}`) <= maxWidth) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

export function fitTailTextLines(
  text: string,
  font: { getTextWidth: (text: string) => number },
  maxWidth: number
) {
  const characters = collectGraphemes(text);
  if (characters.length === 0) return [];
  if (font.getTextWidth(text) <= maxWidth) return [text];

  let firstLineEnd = fittingPrefixEnd(characters, 0, characters.length, font, maxWidth);
  if (firstLineEnd === 0) firstLineEnd = 1;
  if (firstLineEnd === characters.length) return [text];
  const firstLine = characters.slice(0, firstLineEnd).join("");
  const secondLine = characters.slice(firstLineEnd).join("");
  if (font.getTextWidth(secondLine) <= maxWidth) {
    return [
      firstLine,
      secondLine,
    ];
  }

  let lastLineStart = fittingSuffixStart(
    characters,
    0,
    characters.length,
    font,
    maxWidth
  );
  if (lastLineStart === characters.length) lastLineStart -= 1;
  const firstLineStart = fittingSuffixStart(
    characters,
    0,
    lastLineStart,
    font,
    maxWidth,
    "…"
  );
  return [
    `…${characters.slice(firstLineStart, lastLineStart).join("")}`,
    characters.slice(lastLineStart).join(""),
  ];
}

function markerColor(color: SkiaMiniChatSession["markerColor"]) {
  if (color === "red") return "#ef4444";
  if (color === "yellow") return "#eab308";
  if (color === "green") return "#22c55e";
  if (color === "black") return "#111827";
  if (color === "gray") return "#94a3b8";
  return "#cbd5e1";
}

type BoardFooterIconKind = SkiaMiniChatSession["activityTrail"][number]["kind"] | "subagent";

const BOARD_FOOTER_ICON_PATHS: Record<BoardFooterIconKind, string> = {
  reading: "M0.8 1.5C2.6 1.5 4.1 2 5.5 3.1C6.9 2 8.4 1.5 10.2 1.5V9.4C8.4 9.4 6.9 9.8 5.5 10.6C4.1 9.8 2.6 9.4 0.8 9.4ZM5.5 3.1V10.6",
  writing: "M1 10L1.8 7.2L7.8 1.2L10.3 3.7L4.3 9.7ZM7.1 1.9L9.6 4.4M1.8 7.2L4.3 9.7",
  thinking: "M3.4 7.2C1.2 5.4 2.3 1.5 5.5 1.5S9.8 5.4 7.6 7.2C7.1 7.6 7 8 7 8.5H4C4 8 3.9 7.6 3.4 7.2ZM4 10.5H7M5.5 0V0.4M1 2L1.8 2.7M10 2L9.2 2.7",
  web: "M5.5 0.8A4.7 4.7 0 1 0 5.5 10.2A4.7 4.7 0 1 0 5.5 0.8ZM0.8 5.5H10.2M5.5 0.8C3.5 2.8 3.5 8.2 5.5 10.2M5.5 0.8C7.5 2.8 7.5 8.2 5.5 10.2",
  subagent: "M5.5 1A2.1 2.1 0 1 0 5.5 5.2A2.1 2.1 0 1 0 5.5 1ZM1.2 10.5C1.5 7.7 3 6.4 5.5 6.4S9.5 7.7 9.8 10.5",
};

function BoardFooterIcon({
  kind,
  x,
  color,
}: {
  kind: BoardFooterIconKind;
  x: number;
  color: string;
}) {
  return (
    <Group transform={[{ translateX: x }, { translateY: 90.5 }]}>
      <Path
        path={BOARD_FOOTER_ICON_PATHS[kind]}
        color={color}
        style="stroke"
        strokeWidth={1.2}
        strokeCap="round"
        strokeJoin="round"
      />
    </Group>
  );
}

type BoardCardProps = {
  cardWidth: number;
  index: number;
  positions: SharedValue<CardPosition[]>;
  item: SkiaMiniBoardItem;
  selected: boolean;
  titleFontSize: number;
  bodyFontSize: number;
};

function BoardCard({
  cardWidth,
  index,
  positions,
  item,
  selected,
  titleFontSize,
  bodyFontSize,
}: BoardCardProps) {
  const transform = useDerivedValue(() => {
    const position = positions.value[index] || { x: 0, y: 0 };
    return [{ translateX: position.x }, { translateY: position.y }];
  });
  const contentWidth = cardWidth - 32;
  const messageContent = item.kind === "session"
    ? item.lastMessageContent.replace(/\s+/g, " ").trim() || "メッセージを読み込み中…"
    : "";
  const messageLines = useMemo(() => {
    if (!messageContent) return [];
    const widths = new Map<string, number>();
    return fitTailTextLines(messageContent, {
      getTextWidth: (text) => {
        const cached = widths.get(text);
        if (cached !== undefined) return cached;
        const width = paragraphTextWidth(text, bodyFontSize);
        widths.set(text, width);
        return width;
      },
    }, contentWidth);
  }, [bodyFontSize, contentWidth, messageContent]);
  const messageLineHeight = bodyFontSize * 1.25;
  const messageFirstBaseline = messageLines.length === 1 ? 69 : 69 - messageLineHeight / 2;
  const subagentText = item.kind !== "session"
    ? ""
    : item.subagentLoading
      ? "..."
      : `${item.subagentRunningCount}/${item.subagentTotalCount}`;
  const subagentTextWidth = useMemo(
    () => subagentText ? paragraphTextWidth(subagentText, bodyFontSize) : 0,
    [bodyFontSize, subagentText]
  );
  const subagentIconX = cardWidth - 30 - subagentTextWidth;
  const footerRightStart = item.kind === "session"
    ? subagentIconX - (item.activityTrail.length > 0 ? item.activityTrail.length * 15 + 8 : 8)
    : cardWidth - 16;
  const header = item.kind === "session"
    ? item.directoryName
    : item.kind === "file"
      ? item.rootDir.split("/").filter(Boolean).pop() || item.rootDir
      : "ディレクトリ";
  const title = item.kind === "session" ? item.title : item.name;
  const detail = item.kind === "session"
    ? ""
    : item.kind === "file"
      ? item.unavailable ? "ファイルが削除または移動されました" : item.path
      : item.directory;
  const footer = item.kind === "session"
    ? item.updatedAtLabel
    : item.kind === "file"
      ? item.unavailable ? "FILE NOT FOUND" : "FILE"
      : "NEW SESSION";

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
      {item.kind === "session" && item.unread ? (
        <Circle cx={cardWidth - 12} cy={12} r={4} color="#2563eb" />
      ) : null}
      <Group clip={{ x: 10, y: 8, width: cardWidth - 20, height: CARD_HEIGHT - 16 }}>
        <Circle
          cx={18}
          cy={21}
          r={5}
          color={item.kind === "session" ? markerColor(item.markerColor) : "#2563eb"}
        />
        <BoardText
          x={31}
          y={14}
          width={cardWidth - 47}
          text={header}
          fontSize={bodyFontSize}
          color="#64748b"
        />
        <BoardText
          x={16}
          y={34}
          width={contentWidth}
          text={title}
          fontSize={titleFontSize}
          bold
          color="#172033"
        />
        {item.kind === "session" ? messageLines.map((line, index) => (
          <BoardText
            key={index}
            x={16}
            y={messageFirstBaseline + index * messageLineHeight - bodyFontSize}
            width={contentWidth}
            text={line}
            fontSize={bodyFontSize}
            color="#64748b"
          />
        )) : (
          <BoardText
            x={16}
            y={69 - bodyFontSize}
            width={contentWidth}
            text={detail}
            fontSize={bodyFontSize}
            color="#64748b"
          />
        )}
        <Line p1={{ x: 16, y: 88 }} p2={{ x: cardWidth - 16, y: 88 }} color="#e2e8f0" strokeWidth={1} />
        <BoardText
          x={16}
          y={100 - bodyFontSize}
          width={Math.max(20, footerRightStart - 24)}
          text={footer}
          fontSize={bodyFontSize}
          color="#64748b"
        />
        {item.kind === "session" ? item.activityTrail.map((activity, index) => (
          <BoardFooterIcon
            key={`${activity.kind}:${index}`}
            kind={activity.kind}
            x={footerRightStart + index * 15}
            color={activity.active ? "#f97316" : "#94a3b8"}
          />
        )) : null}
        {item.kind === "session" ? (
          <>
            <BoardFooterIcon
              kind="subagent"
              x={subagentIconX}
              color="#64748b"
            />
            <BoardText
              x={cardWidth - 16 - subagentTextWidth}
              y={100 - bodyFontSize}
              width={subagentTextWidth + 1}
              text={subagentText}
              fontSize={bodyFontSize}
              color="#64748b"
            />
          </>
        ) : null}
      </Group>
    </Group>
  );
}

type SkiaMiniBoardScreenProps = {
  onStartNewSessionInDirectory: (directory: string) => void;
  openSessionHistoryPopup: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory?: string;
    origin?: SessionPopupOrigin;
  }) => void;
};

export function SkiaMiniBoardScreen({
  onStartNewSessionInDirectory,
  openSessionHistoryPopup,
}: SkiaMiniBoardScreenProps) {
  const { width: windowWidth } = useWindowDimensions();
  const { openDrawer } = useAppShell();
  const {
    runnerUrl,
    runnerToken,
    sanitizeTextForTts,
    handleAssistantAudioButtonPress,
  } = useChatScreen();
  const {
    directorySync,
    hydratingPanelCount,
    panelHydrationErrorCount,
    items,
    sections,
    cardTextScale,
    setBoardCardTextScale,
    moveBoardCard,
    addBoardSection,
    updateBoardSection,
    removeBoardSection,
    removeBoardSession,
    removeBoardDirectory,
    removeBoardFile,
    hasBoardFile,
    markBoardFileUnavailable,
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
              ? `${items.length}件を表示・${panelHydrationErrorCount}件の読込失敗`
              : directorySync.phase === "partial_error"
                ? `${items.length}件を表示・一部更新失敗`
                : `${items.length}件を表示`;
  const [selectedCardId, setSelectedCardId] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [editingSectionId, setEditingSectionId] = useState("");
  const [tool, setTool] = useState<"select" | "section">("select");
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [fileMenuRootDir, setFileMenuRootDir] = useState("");
  const [pendingFileAction, setPendingFileAction] = useState<{
    item: Extract<SkiaMiniBoardItem, { kind: "file" }>;
    action: "open" | "menu";
  } | null>(null);
  const [runnerMedia, setRunnerMedia] = useState<RunnerMediaFile | null>(null);
  const [runnerFileViewerTarget, setRunnerFileViewerTarget] = useState<RunnerFileViewerTarget | null>(null);
  const [viewportWidth, setViewportWidth] = useState(windowWidth);
  const cardWidth = Math.max(
    SKIA_BOARD_MIN_CARD_WIDTH,
    Math.min(270, (viewportWidth - BOARD_PADDING * 2 - CARD_GAP) / 2)
  );
  const positions = useSharedValue<CardPosition[]>([]);
  const sectionRects = useSharedValue<SkiaBoardSectionRect[]>([]);
  const draftSection = useSharedValue<SkiaBoardSectionRect>(EMPTY_DRAFT_SECTION);
  const boardX = useSharedValue(0);
  const boardY = useSharedValue(0);
  const scale = useSharedValue(1);
  const gestureStartX = useSharedValue(0);
  const gestureStartY = useSharedValue(0);
  const gestureStartScale = useSharedValue(1);
  const pinchBoardX = useSharedValue(0);
  const pinchBoardY = useSharedValue(0);
  const activeCardIndex = useSharedValue(-1);
  const activeCardId = useSharedValue("");
  const activeCardX = useSharedValue(0);
  const activeCardY = useSharedValue(0);
  const selectedCardIndex = useSharedValue(-1);
  const selectedSectionIndex = useSharedValue(-1);
  const activeSectionGesture = useSharedValue<ActiveSectionGesture>(EMPTY_ACTIVE_SECTION_GESTURE);
  const toolMode = useSharedValue<"select" | "section">("select");
  const touchSequenceHadMultiplePointers = useSharedValue(false);
  const panStartScreenX = useSharedValue(0);
  const panStartScreenY = useSharedValue(0);

  const titleFontSize = 12 * cardTextScale;
  const bodyFontSize = 9 * cardTextScale;
  const sectionLabelParagraphs = useMemo(
    () => sections.map((section) => createBoardParagraph(section.label, 1000, {
      color: section.id === selectedSectionId ? "#1d4ed8" : "#475569",
      fontSize: 12,
      bold: true,
    })),
    [sections, selectedSectionId]
  );

  // ボードステート(col/row)から画面座標を再構築する。ドラッグ中はSharedValueのみが
  // 動き、ドラッグ終了時のcommitでステートへ反映されるため、同値の再適用になる。
  const positionsKey = useMemo(() => (
    items.map((item) => `${item.cardId}:${item.col}:${item.row}`).join("|")
  ), [items]);
  // 描画前(useLayoutEffect)に反映し、原点に一瞬固まって見えるフレームを避ける。
  const appliedPositionsKeyRef = useRef("");
  useLayoutEffect(() => {
    const key = `${cardWidth}|${positionsKey}`;
    if (appliedPositionsKeyRef.current === key) return;
    appliedPositionsKeyRef.current = key;
    positions.value = items.map((item) => (
      cardPositionFromGrid(item.col, item.row, cardWidth)
    ));
  }, [cardWidth, items, positions, positionsKey]);

  const renderedSectionRects = useMemo(
    () => sections.map((section) => sectionRectFromGrid(section, cardWidth)),
    [cardWidth, sections]
  );
  useLayoutEffect(() => {
    sectionRects.value = renderedSectionRects;
    selectedSectionIndex.value = sections.findIndex((section) => section.id === selectedSectionId);
  }, [
    renderedSectionRects,
    sectionRects,
    sections,
    selectedSectionId,
    selectedSectionIndex,
  ]);

  // カードの並び(搭載セッション)が変わったら、indexベースの選択をクリアする。
  const cardIdsKey = useMemo(() => items.map((item) => item.cardId).join("|"), [items]);
  useEffect(() => {
    selectedCardIndex.value = -1;
    setSelectedCardId("");
  }, [cardIdsKey, selectedCardIndex]);

  const selectTool = useCallback((next: "select" | "section") => {
    toolMode.value = next;
    setTool(next);
    if (next === "section") {
      selectedCardIndex.value = -1;
      selectedSectionIndex.value = -1;
      setSelectedCardId("");
      setSelectedSectionId("");
    }
  }, [selectedCardIndex, selectedSectionIndex, toolMode]);

  const showUnavailableFileMenu = useCallback((item: Extract<SkiaMiniBoardItem, { kind: "file" }>) => {
    Alert.alert(
      item.name,
      "ファイルが削除または移動されました。",
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "Skiaボードから除外",
          style: "destructive",
          onPress: () => removeBoardFile(item.rootDir, item.path),
        },
      ]
    );
  }, [removeBoardFile]);

  const handleCardTap = useCallback((index: number) => {
    if (index < 0) {
      selectedCardIndex.value = -1;
      setSelectedCardId("");
      return;
    }
    const item = items[index];
    if (!item) return;
    selectedSectionIndex.value = -1;
    setSelectedSectionId("");
    if (item.kind === "file") {
      if (selectedCardId === item.cardId) {
        if (item.unavailable) {
          showUnavailableFileMenu(item);
          return;
        }
        setFileMenuRootDir(item.rootDir);
        setPendingFileAction({ item, action: "open" });
        return;
      }
      selectedCardIndex.value = index;
      setSelectedCardId(item.cardId);
      return;
    }
    if (item.kind === "directory") {
      if (selectedCardId === item.cardId) {
        onStartNewSessionInDirectory(item.directory);
        return;
      }
      selectedCardIndex.value = index;
      setSelectedCardId(item.cardId);
      return;
    }
    if (selectedCardId === item.cardId) {
      // プレビュー用パネルは直接開かず、ドロワーと同じ専用パネルのポップアップで開く
      // (毎オープン時にJSONLからhydrateされ、常に最新の本文になる)。
      openSessionHistoryPopup({
        sessionId: item.sessionId,
        directory: item.directory,
        source: item.source,
        origin: "skia_board",
      });
      return;
    }
    selectedCardIndex.value = index;
    setSelectedCardId(item.cardId);
  }, [
    items,
    onStartNewSessionInDirectory,
    openSessionHistoryPopup,
    selectedCardId,
    selectedCardIndex,
    selectedSectionIndex,
    showUnavailableFileMenu,
  ]);

  const handleSectionTap = useCallback((index: number) => {
    selectedCardIndex.value = -1;
    setSelectedCardId("");
    selectedSectionIndex.value = index;
    setSelectedSectionId(sections[index]?.id || "");
  }, [sections, selectedCardIndex, selectedSectionIndex]);

  // ドラッグ終了時に画面座標をグリッド単位へ戻してボードステートへ保存する。
  // ドラッグ中に候補が増減してindexがずれても別セッションを上書きしないよう、
  // 対象と座標はドラッグ開始時のカードに紐づけ、候補の増減後もindexから引き直さない。
  const commitCardPosition = useCallback((cardId: string, x: number, y: number) => {
    if (!cardId) return;
    const grid = gridFromCardPosition(x, y, cardWidth);
    moveBoardCard(cardId, grid.col, grid.row);
  }, [cardWidth, moveBoardCard]);

  const commitSectionRect = useCallback((sectionId: string, rect: SkiaBoardSectionRect) => {
    if (!sectionId) return;
    updateBoardSection(sectionId, gridFromSectionRect(rect, cardWidth));
  }, [cardWidth, updateBoardSection]);

  const commitNewSection = useCallback((rect: SkiaBoardSectionRect) => {
    if (
      rect.width < SKIA_BOARD_MIN_SECTION_SIZE
      || rect.height < SKIA_BOARD_MIN_SECTION_SIZE
    ) return;
    const id = `section:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const grid = gridFromSectionRect(rect, cardWidth);
    addBoardSection({
      id,
      label: "セクション",
      ...grid,
      color: DEFAULT_SECTION_COLOR,
      opacity: 0.2,
      borderOnly: false,
    });
    setSelectedSectionId(id);
    setSelectedCardId("");
    toolMode.value = "select";
    setTool("select");
  }, [addBoardSection, cardWidth, toolMode]);

  const confirmRemoveCard = useCallback((index: number) => {
    const item = items[index];
    if (!item || item.kind === "file") return;
    const label = item.kind === "session" ? item.title || item.sessionId : item.name;
    Alert.alert(
      "カードを削除",
      item.kind === "session"
        ? `「${label}」をボードから外しますか?\n外したセッションは自動では再追加されません。`
        : `「${label}」をボードから外しますか?`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: () => {
            if (item.kind === "session") {
              removeBoardSession(item.sessionId);
            } else {
              removeBoardDirectory(item.directory);
            }
          },
        },
      ]
    );
  }, [items, removeBoardDirectory, removeBoardSession]);

  const openCardContextMenu = useCallback((index: number) => {
    const item = items[index];
    if (!item) return;
    if (item.kind !== "file") {
      confirmRemoveCard(index);
      return;
    }
    if (item.unavailable) {
      showUnavailableFileMenu(item);
      return;
    }
    setFileMenuRootDir(item.rootDir);
    setPendingFileAction({ item, action: "menu" });
  }, [confirmRemoveCard, items, showUnavailableFileMenu]);

  const openSectionContextMenu = useCallback((index: number) => {
    const section = sections[index];
    if (!section) return;
    selectedCardIndex.value = -1;
    selectedSectionIndex.value = index;
    setSelectedCardId("");
    setSelectedSectionId(section.id);
    setEditingSectionId(section.id);
  }, [sections, selectedCardIndex, selectedSectionIndex]);

  const confirmRemoveSection = useCallback((section: { id: string }) => {
    setEditingSectionId("");
    Alert.alert("セクションを削除", "このセクションをボードから削除しますか?", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: () => {
          removeBoardSection(section.id);
          setSelectedSectionId("");
          selectedSectionIndex.value = -1;
        },
      },
    ]);
  }, [removeBoardSection, selectedSectionIndex]);

  const showInfoToast = useCallback((textRaw: unknown) => {
    const text = String(textRaw || "").trim();
    if (text) Alert.alert("完了", text);
  }, []);
  const getPathLabel = useCallback((pathRaw: unknown) => {
    const path = normalizeRunnerPath(pathRaw);
    return path.split("/").filter(Boolean).pop() || path || "file";
  }, []);
  const refreshBoardFile = useCallback(async () => {}, []);
  const {
    renameTarget,
    requestRename,
    cancelRename,
    renameFile,
    renameFileTarget,
    editTarget,
    requestEdit,
    cancelEdit,
    writeFileContent,
    autoSaveFileContent,
    deleteFile,
  } = useWorkspaceFileMutations({
    runnerUrl,
    runnerToken,
    rootDirectory: fileMenuRootDir,
    refreshChangedFiles: refreshBoardFile,
    showInfoToast,
    onPathRemoved: (target) => markBoardFileUnavailable(fileMenuRootDir, target.path),
  });
  const speakFileText = useCallback((text: string, target: WorkspaceFileTarget) => {
    const content = sanitizeTextForTts(text);
    if (!content) {
      showInfoToast(`読み上げるテキストがありません: ${target.path}`);
      return;
    }
    void handleAssistantAudioButtonPress({
      id: `skia-board-file-tts:${target.path}`,
      role: "assistant",
      content,
    });
  }, [handleAssistantAudioButtonPress, sanitizeTextForTts, showInfoToast]);

  useEffect(() => {
    const pending = pendingFileAction;
    const file = pending?.item;
    if (!file || fileMenuRootDir !== file.rootDir) return;
    setPendingFileAction(null);
    const params = {
      filePathRaw: file.path,
      fileNameRaw: file.name,
      runnerUrl,
      runnerToken,
      rootDir: file.rootDir,
      allowExecute: true,
      allowMutate: true,
      getPathLabel,
      showInfoToast,
      onOpenMedia: setRunnerMedia,
      onOpenFile: setRunnerFileViewerTarget,
      onSpeakText: speakFileText,
      onRequestRename: requestRename,
      onRequestEdit: requestEdit,
      onRequestDelete: deleteFile,
      onRenameFile: renameFileTarget,
      skiaBoard: {
        hasFile: hasBoardFile,
        removeFile: removeBoardFile,
      },
    };
    if (pending.action === "open") {
      openRunnerFile(params);
    } else {
      openRunnerFileContextMenu(params);
    }
  }, [
    deleteFile,
    fileMenuRootDir,
    getPathLabel,
    hasBoardFile,
    pendingFileAction,
    removeBoardFile,
    renameFileTarget,
    requestEdit,
    requestRename,
    runnerToken,
    runnerUrl,
    showInfoToast,
    speakFileText,
  ]);

  const boardTranslate = useDerivedValue(() => [
    { translateX: boardX.value },
    { translateY: boardY.value },
  ]);
  const boardScale = useDerivedValue(() => [{ scale: scale.value }]);

  const gestures = useMemo(() => {
    // worklet内でindex→cardIdを引くための軽量スナップショット(文字列のみ)。
    const cardIds = items.map((item) => item.cardId);
    const drag = Gesture.Pan()
      .maxPointers(2)
      .minDistance(10)
      .onTouchesDown((event) => {
        if (event.numberOfTouches === 1) {
          touchSequenceHadMultiplePointers.value = false;
        } else if (event.numberOfTouches > 1) {
          touchSequenceHadMultiplePointers.value = true;
        }
      })
      .onBegin((event) => {
        panStartScreenX.value = event.x;
        panStartScreenY.value = event.y;
        activeCardIndex.value = -1;
        activeCardId.value = "";
        activeSectionGesture.value = EMPTY_ACTIVE_SECTION_GESTURE;
      })
      .onStart(() => {
        const x = (panStartScreenX.value - boardX.value) / scale.value;
        const y = (panStartScreenY.value - boardY.value) / scale.value;

        for (let index = items.length - 1; index >= 0; index -= 1) {
          const position = positions.value[index];
          if (
            position
            && x >= position.x
            && x <= position.x + cardWidth
            && y >= position.y
            && y <= position.y + CARD_HEIGHT
          ) {
            if (toolMode.value === "section") {
              activeSectionGesture.value = { ...activeSectionGesture.value, action: "blocked" };
            } else if (selectedCardIndex.value === index) {
              activeCardIndex.value = index;
              activeCardId.value = cardIds[index] || "";
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

        if (toolMode.value === "section") {
          const start = { id: "draft", x, y, width: 0, height: 0 };
          activeSectionGesture.value = {
            index: -1,
            sectionId: "",
            action: "create",
            start,
            current: start,
          };
          draftSection.value = start;
          return;
        }

        const selectedIndex = selectedSectionIndex.value;
        const selectedRect = sectionRects.value[selectedIndex];
        if (selectedRect) {
          const action = sectionDragActionAtPoint(selectedRect, x, y, scale.value);
          if (action) {
            activeSectionGesture.value = {
              index: selectedIndex,
              sectionId: selectedRect.id,
              action,
              start: selectedRect,
              current: selectedRect,
            };
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
        const sectionGesture = activeSectionGesture.value;
        const sectionAction = sectionGesture.action;
        if (sectionAction === "blocked") return;
        if (sectionAction === "create") {
          draftSection.value = {
            id: "draft",
            ...sectionRectFromPoints(
              sectionGesture.start.x,
              sectionGesture.start.y,
              sectionGesture.start.x + event.translationX / scale.value,
              sectionGesture.start.y + event.translationY / scale.value
            ),
          };
          return;
        }
        const sectionIndex = sectionGesture.index;
        if (sectionIndex >= 0 && sectionAction) {
          const nextRect = transformSectionRect(
            sectionGesture.start,
            sectionAction as SkiaBoardSectionDragAction,
            event.translationX / scale.value,
            event.translationY / scale.value
          );
          const nextSections = sectionRects.value.slice();
          nextSections[sectionIndex] = nextRect;
          sectionRects.value = nextSections;
          activeSectionGesture.value = { ...sectionGesture, current: nextRect };
          return;
        }
        boardX.value = gestureStartX.value + event.translationX;
        boardY.value = gestureStartY.value + event.translationY;
      })
      .onFinalize(() => {
        const index = activeCardIndex.value;
        const cardId = activeCardId.value;
        const x = activeCardX.value;
        const y = activeCardY.value;
        const sectionGesture = activeSectionGesture.value;
        activeCardIndex.value = -1;
        activeCardId.value = "";
        if (touchSequenceHadMultiplePointers.value) {
          if (sectionGesture.index >= 0) {
            const restoredSections = sectionRects.value.slice();
            restoredSections[sectionGesture.index] = sectionGesture.start;
            sectionRects.value = restoredSections;
          }
          activeSectionGesture.value = EMPTY_ACTIVE_SECTION_GESTURE;
          draftSection.value = EMPTY_DRAFT_SECTION;
          return;
        }
        if (index >= 0 && cardId) {
          runOnJS(commitCardPosition)(cardId, x, y);
          return;
        }
        const { action, sectionId, current } = sectionGesture;
        const rect = action === "create" ? draftSection.value : current;
        activeSectionGesture.value = EMPTY_ACTIVE_SECTION_GESTURE;
        draftSection.value = EMPTY_DRAFT_SECTION;
        if (action === "create") {
          runOnJS(commitNewSection)(rect);
        } else if (sectionId) {
          runOnJS(commitSectionRect)(sectionId, rect);
        }
      });

    const tap = Gesture.Tap()
      .maxDistance(8)
      .onEnd((event, success) => {
        if (!success || touchSequenceHadMultiplePointers.value) return;
        if (toolMode.value === "section") return;
        const x = (event.x - boardX.value) / scale.value;
        const y = (event.y - boardY.value) / scale.value;
        for (let index = items.length - 1; index >= 0; index -= 1) {
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
        for (let index = sectionRects.value.length - 1; index >= 0; index -= 1) {
          const section = sectionRects.value[index];
          if (section && pointIsInsideSection(section, x, y)) {
            runOnJS(handleSectionTap)(index);
            return;
          }
        }
        runOnJS(handleSectionTap)(-1);
        runOnJS(handleCardTap)(-1);
      });

    // 長押しの移動許容内ではpanがactiveにならないため、選択状態に関係なく
    // コンテキストメニューを開ける。閾値を越えた場合だけpanがdragを所有する。
    const longPress = Gesture.LongPress()
      .minDuration(500)
      .onStart((event) => {
        if (touchSequenceHadMultiplePointers.value || toolMode.value === "section") return;
        const x = (event.x - boardX.value) / scale.value;
        const y = (event.y - boardY.value) / scale.value;
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const position = positions.value[index];
          if (
            position
            && x >= position.x
            && x <= position.x + cardWidth
            && y >= position.y
            && y <= position.y + CARD_HEIGHT
          ) {
            runOnJS(openCardContextMenu)(index);
            return;
          }
        }
        for (let index = sectionRects.value.length - 1; index >= 0; index -= 1) {
          const section = sectionRects.value[index];
          if (section && pointIsInsideSection(section, x, y)) {
            runOnJS(openSectionContextMenu)(index);
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
        const shouldAnimateZoom = Platform.OS === "macos" && event.numberOfPointers === 1;
        if (event.numberOfPointers < 2 && !shouldAnimateZoom) return;
        const nextScale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, gestureStartScale.value * event.scale)
        );
        const nextBoardX = event.focalX - pinchBoardX.value * nextScale;
        const nextBoardY = event.focalY - pinchBoardY.value * nextScale;
        if (!shouldAnimateZoom) {
          scale.value = nextScale;
          boardX.value = nextBoardX;
          boardY.value = nextBoardY;
          return;
        }
        scale.value = withTiming(nextScale, ZOOM_ANIMATION);
        boardX.value = withTiming(nextBoardX, ZOOM_ANIMATION);
        boardY.value = withTiming(nextBoardY, ZOOM_ANIMATION);
      });

    return Gesture.Simultaneous(drag, pinch, tap, longPress);
  }, [
    activeCardIndex,
    activeCardId,
    activeCardX,
    activeCardY,
    activeSectionGesture,
    boardX,
    boardY,
    cardWidth,
    commitCardPosition,
    commitNewSection,
    commitSectionRect,
    draftSection,
    gestureStartScale,
    gestureStartX,
    gestureStartY,
    handleCardTap,
    handleSectionTap,
    items,
    openCardContextMenu,
    openSectionContextMenu,
    pinchBoardX,
    pinchBoardY,
    positions,
    scale,
    selectedCardIndex,
    selectedSectionIndex,
    sectionRects,
    panStartScreenX,
    panStartScreenY,
    touchSequenceHadMultiplePointers,
    toolMode,
  ]);

  // カード位置には触らず、パン・ズームだけを初期化する(整頓ボタンとの差別化)。
  const resetViewport = () => {
    boardX.value = 0;
    boardY.value = 0;
    scale.value = 1;
    selectedCardIndex.value = -1;
    selectedSectionIndex.value = -1;
    setSelectedCardId("");
    setSelectedSectionId("");
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
  const editingSection = sections.find((section) => section.id === editingSectionId) || null;

  const boardMenuPanelContent = (
    <>
      <TouchableOpacity
        style={screenStyles.menuAction}
        onPress={() => {
          setBoardMenuOpen(false);
          tidyBoard();
        }}
        accessibilityRole="button"
        accessibilityLabel="カードをグリッドに整頓"
      >
        <Ionicons name="grid-outline" size={17} color="#334155" />
        <Text style={screenStyles.menuActionText}>Tidy</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={screenStyles.menuAction}
        onPress={() => {
          setBoardMenuOpen(false);
          resetViewport();
        }}
        accessibilityRole="button"
        accessibilityLabel="表示位置とズームをリセット"
      >
        <Ionicons name="locate-outline" size={17} color="#334155" />
        <Text style={screenStyles.menuActionText}>Reset</Text>
      </TouchableOpacity>
      <View style={screenStyles.menuDivider} />
      <View style={screenStyles.fontScaleRow}>
        <Text style={screenStyles.menuActionText}>Card text</Text>
        <TouchableOpacity
          style={screenStyles.fontScaleButton}
          onPress={() => setBoardCardTextScale(cardTextScale - SKIA_BOARD_TEXT_SCALE_STEP)}
          disabled={cardTextScale <= SKIA_BOARD_MIN_TEXT_SCALE}
          accessibilityRole="button"
          accessibilityLabel="カード文字を小さくする"
        >
          <Ionicons
            name="remove"
            size={17}
            color={cardTextScale <= SKIA_BOARD_MIN_TEXT_SCALE ? "#94a3b8" : "#334155"}
          />
        </TouchableOpacity>
        <Text style={screenStyles.fontScaleValue}>{Math.round(cardTextScale * 100)}%</Text>
        <TouchableOpacity
          style={screenStyles.fontScaleButton}
          onPress={() => setBoardCardTextScale(cardTextScale + SKIA_BOARD_TEXT_SCALE_STEP)}
          disabled={cardTextScale >= SKIA_BOARD_MAX_TEXT_SCALE}
          accessibilityRole="button"
          accessibilityLabel="カード文字を大きくする"
        >
          <Ionicons
            name="add"
            size={17}
            color={cardTextScale >= SKIA_BOARD_MAX_TEXT_SCALE ? "#94a3b8" : "#334155"}
          />
        </TouchableOpacity>
      </View>
    </>
  );
  const boardMenu = (
    <View style={screenStyles.menuBackdrop}>
      <Pressable
        accessibilityLabel="ボードメニューを閉じる"
        onPress={() => setBoardMenuOpen(false)}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView pointerEvents="box-none" style={screenStyles.menuSafeArea}>
        <View style={screenStyles.menuPanel}>
          {boardMenuPanelContent}
        </View>
      </SafeAreaView>
    </View>
  );

  return (
    <View style={screenStyles.screen}>
      <SafeAreaView style={screenStyles.headerSafeArea}>
        <View style={screenStyles.header}>
          <TouchableOpacity
            style={screenStyles.headerButton}
            onPress={openDrawer}
            accessibilityRole="button"
            accessibilityLabel="ナビゲーションを開く"
          >
            <Text style={screenStyles.headerButtonText}>☰</Text>
          </TouchableOpacity>
          <View style={screenStyles.headerSpacer} />
          <TouchableOpacity
            style={screenStyles.headerButton}
            onPress={() => setBoardMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="ボードメニューを開く"
          >
            <Ionicons name="ellipsis-horizontal" size={22} color="#334155" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

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
                {sections.map((section, index) => (
                  <SkiaBoardSectionRegion
                    key={section.id}
                    index={index}
                    sections={sectionRects}
                    section={section}
                    initialRect={renderedSectionRects[index]}
                    selected={section.id === selectedSectionId}
                  />
                ))}
                <SkiaBoardSectionDraft draft={draftSection} color={DEFAULT_SECTION_COLOR} />
              </Group>
            </Group>
            {sections.map((section, index) => (
              <SkiaBoardSectionOverlay
                key={section.id}
                index={index}
                sections={sectionRects}
                initialRect={renderedSectionRects[index]}
                selected={section.id === selectedSectionId}
                boardX={boardX}
                boardY={boardY}
                scale={scale}
                labelParagraph={sectionLabelParagraphs[index]}
              />
            ))}
            <Group transform={boardTranslate}>
              <Group transform={boardScale}>
                {items.map((item, index) => (
                  <BoardCard
                    key={item.cardId}
                    cardWidth={cardWidth}
                    index={index}
                    positions={positions}
                    item={item}
                    selected={item.cardId === selectedCardId}
                    titleFontSize={titleFontSize}
                    bodyFontSize={bodyFontSize}
                  />
                ))}
              </Group>
            </Group>
          </Canvas>
        </View>
      </GestureDetector>

      <SafeAreaView pointerEvents="box-none" style={screenStyles.toolsSafeArea}>
        <View style={screenStyles.tools}>
          <TouchableOpacity
            style={[screenStyles.toolButton, tool === "select" && screenStyles.toolButtonSelected]}
            onPress={() => selectTool("select")}
            accessibilityRole="button"
            accessibilityState={{ selected: tool === "select" }}
            accessibilityLabel="選択と移動"
          >
            <Ionicons name="navigate-outline" size={21} color={tool === "select" ? "#ffffff" : "#334155"} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[screenStyles.toolButton, tool === "section" && screenStyles.toolButtonSelected]}
            onPress={() => selectTool("section")}
            accessibilityRole="button"
            accessibilityState={{ selected: tool === "section" }}
            accessibilityLabel="セクションを作成"
          >
            <Ionicons name="scan-outline" size={22} color={tool === "section" ? "#ffffff" : "#334155"} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <SafeAreaView
        pointerEvents="none"
        style={screenStyles.statusSafeArea}
        testID="skia-board-status-safe-area"
      >
        <View style={screenStyles.statusPill} testID="skia-board-status-pill">
          <Text style={screenStyles.statusText}>
            {syncStatusText}
          </Text>
        </View>
      </SafeAreaView>
      <AppModal
        visible={boardMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setBoardMenuOpen(false)}
      >
        {boardMenu}
      </AppModal>
      <SkiaBoardSectionEditor
        section={editingSection}
        onClose={() => setEditingSectionId("")}
        onSave={(update) => {
          if (editingSectionId) updateBoardSection(editingSectionId, update);
          setEditingSectionId("");
        }}
        onDelete={() => {
          if (editingSection) confirmRemoveSection(editingSection);
        }}
      />
      <RunnerMediaViewer
        media={runnerMedia}
        onRequestClose={() => setRunnerMedia(null)}
      />
      <RunnerFileViewer
        target={runnerFileViewerTarget}
        runnerUrl={runnerUrl}
        runnerToken={runnerToken}
        onRequestClose={() => setRunnerFileViewerTarget(null)}
        onAutoSave={autoSaveFileContent}
      />
      <WorkspaceFileRenameDialog
        target={renameTarget}
        onCancel={cancelRename}
        onRename={renameFile}
      />
      <WorkspaceTextFileEditor
        target={editTarget}
        runnerUrl={runnerUrl}
        runnerToken={runnerToken}
        rootDirectory={fileMenuRootDir}
        onClose={cancelEdit}
        onSave={writeFileContent}
      />
    </View>
  );
}

const screenStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#eef2f7",
  },
  headerSafeArea: {
    backgroundColor: "transparent",
  },
  header: {
    minHeight: 54,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  headerButtonText: {
    color: "#27364b",
    fontSize: 20,
    fontWeight: "700",
  },
  headerSpacer: {
    flex: 1,
  },
  canvasHost: {
    flex: 1,
    overflow: "hidden",
  },
  toolsSafeArea: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
  },
  tools: {
    marginBottom: 12,
    padding: 5,
    borderRadius: 14,
    flexDirection: "row",
    gap: 4,
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    shadowColor: "#0f172a",
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  toolButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  toolButtonSelected: {
    backgroundColor: "#2563eb",
  },
  statusPill: {
    marginLeft: 14,
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: "rgba(23, 32, 51, 0.84)",
  },
  statusSafeArea: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "flex-start",
  },
  statusText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: "transparent",
  },
  menuSafeArea: {
    flex: 1,
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  menuPanel: {
    width: 220,
    padding: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    shadowColor: "#0f172a",
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  menuAction: {
    minHeight: 44,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  menuActionText: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "700",
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 5,
    backgroundColor: "#e2e8f0",
  },
  fontScaleRow: {
    minHeight: 44,
    paddingLeft: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  fontScaleButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f1f5f9",
  },
  fontScaleValue: {
    minWidth: 35,
    color: "#64748b",
    fontSize: 11,
    textAlign: "center",
  },
});
