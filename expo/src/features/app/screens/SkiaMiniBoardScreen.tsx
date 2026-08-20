import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  ClipOp,
  createPicture,
  FontWeight,
  Group,
  PaintStyle,
  Path,
  Picture,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkPaint,
} from "@shopify/react-native-skia";
import { collectGraphemes } from "unicode-segmenter/grapheme";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withDecay,
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
// 指を止めてから離した場合など、この時間より古いピンチ速度では慣性を開始しない。
const PINCH_MOMENTUM_MAX_AGE_MS = 120;
// ピンチ終了(2本→1本)後の残り指の許容移動量。2本の指は完全同時には離れず微小な
// moveがほぼ必ず入るため、この範囲内なら速度サンプルを保持する。超えたら意図的な
// ドラッグとみなして破棄する(PanのminDistance=10と整合)。
const PINCH_REMAINING_TOUCH_SLOP = 10;
// 慣性を開始する最低速度。指を止めて離した時のジッター(数十px/s)では滑らせず、
// フリック(数百px/s以上)だけを通すための下限。scaleも同様の趣旨の下限。
const CAMERA_INERTIA_MIN_SPEED = 50;
const CAMERA_INERTIA_MIN_SCALE_SPEED = 0.5;
// 離し際の指の転がりは「静止→ごく短い高速移動」で、瞬間速度はしきい値を超えうる。
// フリックとの構造的な違いは連続した移動量なので、連続サンプル列(間隔<=64ms)内の
// 累積移動量がこの値に満たない成分は慣性へ採用しない。
const PINCH_MOMENTUM_MIN_FOCAL_TRAVEL = 24;
const PINCH_MOMENTUM_MIN_SCALE_TRAVEL = 0.08;
// 指では物理的に出せない速度(px/s)のfocal移動は座標系のジャンプとみなし、
// 速度サンプルとして採用せず基準位置だけを更新する。
const PINCH_FOCAL_JUMP_SPEED = 5000;

// ピンチ中に計測した直近のカメラ速度(focal移動とスケール変化)。
// focalDistance/scaleDistanceは連続サンプル列内の累積移動量(ギャップでリセット)。
type PinchMomentum = {
  focalX: number;
  focalY: number;
  scale: number;
  velocityX: number;
  velocityY: number;
  scaleVelocity: number;
  focalDistance: number;
  scaleDistance: number;
  at: number;
};
const EMPTY_PINCH_MOMENTUM: PinchMomentum = {
  focalX: 0,
  focalY: 0,
  scale: 1,
  velocityX: 0,
  velocityY: 0,
  scaleVelocity: 0,
  focalDistance: 0,
  scaleDistance: 0,
  at: 0,
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

type BoardCardProps = {
  cardWidth: number;
  index: number;
  positions: SharedValue<CardPosition[]>;
  item: SkiaMiniBoardItem;
  selected: boolean;
  titleFontSize: number;
  bodyFontSize: number;
};

// item(内容が変わった時だけidentityが変わる)以外のpropsは安定しているため、
// memoで「内容が変わったカードだけ」再レンダリングされる。
const BoardCard = memo(function BoardCard({
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
  const isSession = item.kind === "session";
  const markerFill = isSession ? markerColor(item.markerColor) : "#2563eb";
  const showUnread = isSession && item.unread;
  const activityTrail = isSession ? item.activityTrail : [];
  // 配列の参照はitemsの再構築ごとに変わるため、内容ベースのキーでPicture再生成を判定する。
  const activityTrailKey = activityTrail
    .map((activity) => `${activity.kind}:${activity.active ? 1 : 0}`)
    .join("|");

  // カード内容(位置transform以外)は変わった時だけSkPictureへ焼き直す。パン・ズーム中の
  // 毎フレーム再生がカード1枚あたり save/concat/drawPicture の約3コマンドに減り、
  // ベクタ再生なのでズームしても劣化しない。選択枠もキーに含める(選択変更時のみ再生成)。
  const picture = useMemo(() => createPicture((canvas) => {
    const fillPaint = (color: string, alpha?: number) => {
      const paint = Skia.Paint();
      paint.setAntiAlias(true);
      paint.setColor(Skia.Color(color));
      if (alpha !== undefined) paint.setAlphaf(alpha);
      return paint;
    };
    const strokePaint = (color: string, width: number) => {
      const paint = fillPaint(color);
      paint.setStyle(PaintStyle.Stroke);
      paint.setStrokeWidth(width);
      return paint;
    };
    const drawCardRect = (x: number, y: number, paint: SkPaint) => {
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, cardWidth, CARD_HEIGHT), 14, 14),
        paint
      );
    };
    const drawText = (
      text: string,
      x: number,
      y: number,
      width: number,
      style: BoardTextStyle
    ) => {
      const paragraph = createBoardParagraph(text, width, style);
      paragraph.paint(canvas, x, y);
      paragraph.dispose();
    };
    const drawFooterIcon = (kind: BoardFooterIconKind, x: number, color: string) => {
      const path = Skia.Path.MakeFromSVGString(BOARD_FOOTER_ICON_PATHS[kind]);
      if (!path) return;
      const paint = strokePaint(color, 1.2);
      paint.setStrokeCap(StrokeCap.Round);
      paint.setStrokeJoin(StrokeJoin.Round);
      canvas.save();
      canvas.translate(x, 90.5);
      canvas.drawPath(path, paint);
      canvas.restore();
      path.dispose();
    };

    drawCardRect(2, 4, fillPaint("#cbd5e1", 0.42));
    drawCardRect(0, 0, fillPaint("#ffffff"));
    drawCardRect(0, 0, strokePaint(selected ? "#2563eb" : "#d7dee8", selected ? 2.5 : 1));
    if (showUnread) {
      canvas.drawCircle(cardWidth - 12, 12, 4, fillPaint("#2563eb"));
    }
    canvas.save();
    canvas.clipRect(
      Skia.XYWHRect(10, 8, cardWidth - 20, CARD_HEIGHT - 16),
      ClipOp.Intersect,
      true
    );
    canvas.drawCircle(18, 21, 5, fillPaint(markerFill));
    drawText(header, 31, 14, cardWidth - 47, { fontSize: bodyFontSize, color: "#64748b" });
    drawText(title, 16, 34, contentWidth, { fontSize: titleFontSize, bold: true, color: "#172033" });
    if (isSession) {
      messageLines.forEach((line, lineIndex) => {
        drawText(
          line,
          16,
          messageFirstBaseline + lineIndex * messageLineHeight - bodyFontSize,
          contentWidth,
          { fontSize: bodyFontSize, color: "#64748b" }
        );
      });
    } else {
      drawText(detail, 16, 69 - bodyFontSize, contentWidth, {
        fontSize: bodyFontSize,
        color: "#64748b",
      });
    }
    canvas.drawLine(16, 88, cardWidth - 16, 88, strokePaint("#e2e8f0", 1));
    drawText(footer, 16, 100 - bodyFontSize, Math.max(20, footerRightStart - 24), {
      fontSize: bodyFontSize,
      color: "#64748b",
    });
    activityTrail.forEach((activity, iconIndex) => {
      drawFooterIcon(
        activity.kind,
        footerRightStart + iconIndex * 15,
        activity.active ? "#f97316" : "#94a3b8"
      );
    });
    if (isSession) {
      drawFooterIcon("subagent", subagentIconX, "#64748b");
      drawText(
        subagentText,
        cardWidth - 16 - subagentTextWidth,
        100 - bodyFontSize,
        subagentTextWidth + 1,
        { fontSize: bodyFontSize, color: "#64748b" }
      );
    }
    canvas.restore();
    // 選択枠(strokeWidth 2.5)が矩形の外へ1.25pxはみ出すため、境界に余白を持たせる。
  }, Skia.XYWHRect(-2, -2, cardWidth + 8, CARD_HEIGHT + 10)), [
    // activityTrailは内容ベースのactivityTrailKeyで代表する(参照は毎回変わるため)。
    activityTrailKey,
    bodyFontSize,
    cardWidth,
    contentWidth,
    detail,
    footer,
    footerRightStart,
    header,
    isSession,
    markerFill,
    messageFirstBaseline,
    messageLineHeight,
    messageLines,
    selected,
    showUnread,
    subagentIconX,
    subagentText,
    subagentTextWidth,
    title,
    titleFontSize,
  ]);

  return (
    <Group transform={transform}>
      <Picture picture={picture} />
    </Group>
  );
});

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

  // カメラ慣性: パン・ピンチ共通の1経路。画面上の基準点(focal)とscaleをwithDecayで
  // 減衰させ、boardX/boardY = focal - anchor * scale の関係で追従させる。anchorは
  // 慣性開始時のfocalが指すボード座標なので、scaleが減衰してもfocal点のズーム
  // 不変性が保たれる。パンはscale速度0の特殊ケースにすぎない。
  const cameraInertiaCount = useSharedValue(0);
  const cameraFocalX = useSharedValue(0);
  const cameraFocalY = useSharedValue(0);
  const cameraAnchorX = useSharedValue(0);
  const cameraAnchorY = useSharedValue(0);
  const pinchMomentum = useSharedValue<PinchMomentum>(EMPTY_PINCH_MOMENTUM);
  // ピンチ終了後に残った指の基準位置(スロップ判定用)。x/yはtracked=trueの時のみ有効。
  const remainingTouchTracked = useSharedValue(false);
  const remainingTouchStartX = useSharedValue(0);
  const remainingTouchStartY = useSharedValue(0);

  const stopCameraInertia = useCallback(() => {
    "worklet";
    if (cameraInertiaCount.value === 0) return;
    cameraInertiaCount.value = 0;
    cancelAnimation(cameraFocalX);
    cancelAnimation(cameraFocalY);
    cancelAnimation(scale);
  }, [cameraFocalX, cameraFocalY, cameraInertiaCount, scale]);

  const startCameraInertia = useCallback((
    focalX: number,
    focalY: number,
    velocityX: number,
    velocityY: number,
    scaleVelocity: number
  ) => {
    "worklet";
    // 指を止めて離した時の測定ジッター程度の速度では滑らせない(フリックとの区別)。
    // しきい値未満の成分は0として扱い、パン・ピンチ共通で同じ判定を通す。
    const hasPanVelocity =
      velocityX * velocityX + velocityY * velocityY
      >= CAMERA_INERTIA_MIN_SPEED * CAMERA_INERTIA_MIN_SPEED;
    const hasScaleVelocity = Math.abs(scaleVelocity) >= CAMERA_INERTIA_MIN_SCALE_SPEED;
    if (!hasPanVelocity && !hasScaleVelocity) return;
    const settle = (finished?: boolean) => {
      if (finished) {
        cameraInertiaCount.value = Math.max(0, cameraInertiaCount.value - 1);
      }
    };
    cameraAnchorX.value = (focalX - boardX.value) / scale.value;
    cameraAnchorY.value = (focalY - boardY.value) / scale.value;
    cameraFocalX.value = focalX;
    cameraFocalY.value = focalY;
    cameraInertiaCount.value = hasScaleVelocity ? 3 : 2;
    cameraFocalX.value = withDecay({ velocity: hasPanVelocity ? velocityX : 0 }, settle);
    cameraFocalY.value = withDecay({ velocity: hasPanVelocity ? velocityY : 0 }, settle);
    if (hasScaleVelocity) {
      scale.value = withDecay(
        { velocity: scaleVelocity, clamp: [MIN_SCALE, MAX_SCALE] },
        settle
      );
    }
  }, [
    boardX,
    boardY,
    cameraAnchorX,
    cameraAnchorY,
    cameraFocalX,
    cameraFocalY,
    cameraInertiaCount,
    scale,
  ]);

  // 慣性中だけfocal/scaleの減衰からカメラ位置を導出する。
  useAnimatedReaction(
    () => (cameraInertiaCount.value > 0
      ? {
          x: cameraFocalX.value - cameraAnchorX.value * scale.value,
          y: cameraFocalY.value - cameraAnchorY.value * scale.value,
        }
      : null),
    (position) => {
      if (!position) return;
      boardX.value = position.x;
      boardY.value = position.y;
    },
    [boardX, boardY, cameraAnchorX, cameraAnchorY, cameraFocalX, cameraFocalY, cameraInertiaCount, scale]
  );

  // ドラッグ・ピンチの入力反映のフレーム駆動化。タッチイベントはvsyncと位相が揃わず、
  // onUpdateで直接カメラへ反映すると「更新0回のフレーム」と「2回のフレーム」が混ざって
  // ガクつく(慣性=withDecayが滑らかなのはフレーム駆動のため)。onUpdateは目標値を
  // 書くだけにし、毎フレーム1回ここでboardX/boardY/scaleとドラッグ中カード座標へ
  // 反映して、カメラ更新経路を慣性と同じフレーム駆動に揃える。
  const cameraTargetX = useSharedValue(0);
  const cameraTargetY = useSharedValue(0);
  const cameraTargetScale = useSharedValue(1);
  const cameraTargetDirty = useSharedValue(false);
  const cardDragDirty = useSharedValue(false);
  const gestureFrameLoopRequested = useSharedValue(false);

  const flushGestureTargets = useCallback(() => {
    "worklet";
    if (cameraTargetDirty.value) {
      cameraTargetDirty.value = false;
      boardX.value = cameraTargetX.value;
      boardY.value = cameraTargetY.value;
      scale.value = cameraTargetScale.value;
    }
    if (cardDragDirty.value) {
      cardDragDirty.value = false;
      const index = activeCardIndex.value;
      if (index >= 0) {
        const x = activeCardX.value;
        const y = activeCardY.value;
        positions.modify((value) => {
          value[index] = { x, y };
          return value;
        });
      }
    }
  }, [
    activeCardIndex,
    activeCardX,
    activeCardY,
    boardX,
    boardY,
    cameraTargetDirty,
    cameraTargetScale,
    cameraTargetX,
    cameraTargetY,
    cardDragDirty,
    positions,
    scale,
  ]);

  const gestureFrameLoop = useFrameCallback(flushGestureTargets, false);
  const setGestureFrameLoopActive = useCallback((active: boolean) => {
    gestureFrameLoop.setActive(active);
  }, [gestureFrameLoop]);
  const requestGestureFrameLoop = useCallback(() => {
    "worklet";
    if (gestureFrameLoopRequested.value) return;
    gestureFrameLoopRequested.value = true;
    runOnJS(setGestureFrameLoopActive)(true);
  }, [gestureFrameLoopRequested, setGestureFrameLoopActive]);
  const releaseGestureFrameLoop = useCallback(() => {
    "worklet";
    // 停止前に未反映の目標値を適用し、最終フレームの座標整合を保証する。
    flushGestureTargets();
    if (!gestureFrameLoopRequested.value) return;
    gestureFrameLoopRequested.value = false;
    runOnJS(setGestureFrameLoopActive)(false);
  }, [flushGestureTargets, gestureFrameLoopRequested, setGestureFrameLoopActive]);

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
  // worklet内でindex→cardIdを引くための軽量スナップショット(文字列のみ)。
  // itemsのidentityではなくカード集合キーに依存させ、内容だけの更新(ラベル・
  // メッセージ等)ではgesturesが再構築されないようにする。
  const cardIds = useMemo(
    () => items.map((item) => item.cardId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cardIdsKeyがitemsのカード集合を代表する
    [cardIdsKey]
  );
  // runOnJS側のハンドラは最新itemsをrefで参照し、itemsのidentity変化でハンドラ
  // (ひいてはgestures)が再構築されないようにする。positionsの再構築(下の
  // useLayoutEffect)と同じpaint前タイミングで更新し、キュー済みのtap/longPressが
  // 「新しいpositionsのindex」で「古いitems」を引く窓を作らない。
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  }, [items]);

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
    const item = itemsRef.current[index];
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
    const item = itemsRef.current[index];
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
  }, [removeBoardDirectory, removeBoardSession]);

  const openCardContextMenu = useCallback((index: number) => {
    const item = itemsRef.current[index];
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
  }, [confirmRemoveCard, showUnavailableFileMenu]);

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
    const drag = Gesture.Pan()
      .maxPointers(2)
      .minDistance(10)
      .onTouchesDown((event) => {
        // 慣性中に画面へ触れたら、その場でカメラを止める。
        stopCameraInertia();
        remainingTouchTracked.value = false;
        if (event.numberOfTouches === 1) {
          touchSequenceHadMultiplePointers.value = false;
          // シーケンス開始: 目標値を現在のカメラへ同期し、フレーム反映ループを起動。
          cameraTargetX.value = boardX.value;
          cameraTargetY.value = boardY.value;
          cameraTargetScale.value = scale.value;
          requestGestureFrameLoop();
        } else if (event.numberOfTouches > 1) {
          touchSequenceHadMultiplePointers.value = true;
        }
      })
      .onTouchesMove((event) => {
        // ピンチが2本→1本になった後(ピンチ終了後)、残った指の累積移動がスロップを
        // 超えたら2本指時代の速度サンプルを破棄する(意図的なドラッグと判定)。
        // 2本の指は完全同時には離れず離し際に微小なmoveがほぼ必ず入るため、
        // スロップ内の動きではサンプルを保持し、通常のピンチ離しの慣性を殺さない。
        // (速度サンプル自体はnumberOfPointers>=2でしか更新されない。)
        if (!touchSequenceHadMultiplePointers.value || event.numberOfTouches >= 2) return;
        const touch = event.changedTouches[0] || event.allTouches[0];
        if (!touch) return;
        if (!remainingTouchTracked.value) {
          remainingTouchTracked.value = true;
          remainingTouchStartX.value = touch.x;
          remainingTouchStartY.value = touch.y;
          return;
        }
        const deltaX = touch.x - remainingTouchStartX.value;
        const deltaY = touch.y - remainingTouchStartY.value;
        if (
          deltaX * deltaX + deltaY * deltaY
          > PINCH_REMAINING_TOUCH_SLOP * PINCH_REMAINING_TOUCH_SLOP
        ) {
          pinchMomentum.value = EMPTY_PINCH_MOMENTUM;
        }
      })
      .onTouchesUp((event) => {
        // ピンチの慣性は全指が離れた時点で開始する(onTouchesUpのnumberOfTouchesは
        // 残っている指の数)。片指が残っている間はカメラを動かさない。
        if (event.numberOfTouches > 0) return;
        if (!touchSequenceHadMultiplePointers.value) return;
        const momentum = pinchMomentum.value;
        if (Date.now() - momentum.at > PINCH_MOMENTUM_MAX_AGE_MS) return;
        // 離し際の指の転がり(静止→ごく短い高速移動)を弾く: 連続した動きの累積量が
        // 十分ある成分だけを慣性へ採用する。フリックは離す前に大きく動いているので通る。
        const focalValid = momentum.focalDistance >= PINCH_MOMENTUM_MIN_FOCAL_TRAVEL;
        const scaleValid = momentum.scaleDistance >= PINCH_MOMENTUM_MIN_SCALE_TRAVEL;
        if (!focalValid && !scaleValid) return;
        // 慣性のanchor計算が最新のカメラ値を見るよう、未反映の目標値を先に適用する。
        flushGestureTargets();
        startCameraInertia(
          momentum.focalX,
          momentum.focalY,
          focalValid ? momentum.velocityX : 0,
          focalValid ? momentum.velocityY : 0,
          scaleValid ? momentum.scaleVelocity : 0
        );
      })
      .onBegin((event) => {
        panStartScreenX.value = event.x;
        panStartScreenY.value = event.y;
        activeCardIndex.value = -1;
        activeCardId.value = "";
        activeSectionGesture.value = EMPTY_ACTIVE_SECTION_GESTURE;
      })
      .onStart(() => {
        flushGestureTargets();
        const x = (panStartScreenX.value - boardX.value) / scale.value;
        const y = (panStartScreenY.value - boardY.value) / scale.value;

        for (let index = cardIds.length - 1; index >= 0; index -= 1) {
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
          // 目標値だけ更新し、positionsへの反映はフレーム反映ループが毎フレーム1回行う。
          activeCardX.value = nextX;
          activeCardY.value = nextY;
          cardDragDirty.value = true;
          requestGestureFrameLoop();
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
          sectionRects.modify((value) => {
            value[sectionIndex] = nextRect;
            return value;
          });
          activeSectionGesture.value = { ...sectionGesture, current: nextRect };
          return;
        }
        cameraTargetX.value = gestureStartX.value + event.translationX;
        cameraTargetY.value = gestureStartY.value + event.translationY;
        cameraTargetDirty.value = true;
        requestGestureFrameLoop();
      })
      .onEnd((event, success) => {
        flushGestureTargets();
        // ボードのパンだけ慣性を付ける(カードドラッグ・セクション操作・ピンチ系列・
        // システム割込みでキャンセルされた場合は除く)。
        if (!success || touchSequenceHadMultiplePointers.value) return;
        if (activeCardIndex.value >= 0 || activeSectionGesture.value.action) return;
        startCameraInertia(event.x, event.y, event.velocityX, event.velocityY, 0);
      })
      .onFinalize(() => {
        // 未反映の目標値を適用してからループを止める(最終座標の整合)。
        releaseGestureFrameLoop();
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
        for (let index = cardIds.length - 1; index >= 0; index -= 1) {
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
        for (let index = cardIds.length - 1; index >= 0; index -= 1) {
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
        // macOSのホイールズーム(1ポインタ)はPanのタッチイベントを発生させないため、
        // ここでも慣性を止める(タッチ端末ではonTouchesDown済みで冪等)。
        stopCameraInertia();
        touchSequenceHadMultiplePointers.value = true;
      })
      .onStart((event) => {
        // 直前のパンの未反映目標値を適用してから、現在のカメラ値を基準にする。
        flushGestureTargets();
        gestureStartScale.value = scale.value;
        pinchBoardX.value = (event.focalX - boardX.value) / scale.value;
        pinchBoardY.value = (event.focalY - boardY.value) / scale.value;
        pinchMomentum.value = {
          ...EMPTY_PINCH_MOMENTUM,
          focalX: event.focalX,
          focalY: event.focalY,
          scale: scale.value,
          at: Date.now(),
        };
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
          // 全指が離れた時の慣性用に、focal移動とscale変化の速度を計測しておく。
          // 1フレームの生値はブレるため、直前の速度と50%ずつ混ぜて滑らかにする。
          // あわせて連続サンプル列内の累積移動量を記録する(離し際スパイクの判別用)。
          const previous = pinchMomentum.value;
          const now = Date.now();
          const dtSeconds = (now - previous.at) / 1000;
          if (dtSeconds > 0) {
            const stepX = event.focalX - previous.focalX;
            const stepY = event.focalY - previous.focalY;
            const scaleStep = nextScale - previous.scale;
            const stepDistance = Math.sqrt(stepX * stepX + stepY * stepY);
            if (stepDistance / dtSeconds > PINCH_FOCAL_JUMP_SPEED) {
              // 指では出せない速度のfocal移動=座標系のジャンプ。速度・累積量には
              // 採用せず、次のサンプルの基準だけを更新する。
              pinchMomentum.value = {
                ...EMPTY_PINCH_MOMENTUM,
                focalX: event.focalX,
                focalY: event.focalY,
                scale: nextScale,
                at: now,
              };
            } else {
              // 前サンプルから64ms超のギャップ=指が止まっていた。速度も累積量も
              // 引き継がず、この瞬間からの動きとして数え直す。
              const gap = dtSeconds > 0.064;
              const blend = gap ? 1 : 0.5;
              const mix = (previousVelocity: number, nextVelocity: number) =>
                previousVelocity + (nextVelocity - previousVelocity) * blend;
              pinchMomentum.value = {
                focalX: event.focalX,
                focalY: event.focalY,
                scale: nextScale,
                velocityX: mix(previous.velocityX, stepX / dtSeconds),
                velocityY: mix(previous.velocityY, stepY / dtSeconds),
                scaleVelocity: mix(previous.scaleVelocity, scaleStep / dtSeconds),
                focalDistance: (gap ? 0 : previous.focalDistance) + stepDistance,
                scaleDistance: (gap ? 0 : previous.scaleDistance) + Math.abs(scaleStep),
                at: now,
              };
            }
          }
          cameraTargetScale.value = nextScale;
          cameraTargetX.value = nextBoardX;
          cameraTargetY.value = nextBoardY;
          cameraTargetDirty.value = true;
          requestGestureFrameLoop();
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
    cameraTargetDirty,
    cameraTargetScale,
    cameraTargetX,
    cameraTargetY,
    cardDragDirty,
    cardIds,
    flushGestureTargets,
    releaseGestureFrameLoop,
    requestGestureFrameLoop,
    handleCardTap,
    handleSectionTap,
    openCardContextMenu,
    openSectionContextMenu,
    pinchBoardX,
    pinchBoardY,
    pinchMomentum,
    positions,
    remainingTouchTracked,
    remainingTouchStartX,
    remainingTouchStartY,
    scale,
    startCameraInertia,
    stopCameraInertia,
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
    stopCameraInertia();
    boardX.value = 0;
    boardY.value = 0;
    scale.value = 1;
    selectedCardIndex.value = -1;
    selectedSectionIndex.value = -1;
    setSelectedCardId("");
    setSelectedSectionId("");
  };

  // グリッド線46本を1つのPathへまとめ、Skiaの描画ノード数を減らす。
  const gridPath = useMemo(() => {
    const path = Skia.Path.Make();
    for (let x = 0; x <= 900; x += 40) {
      path.moveTo(x, 0);
      path.lineTo(x, 900);
    }
    for (let y = 0; y <= 900; y += 40) {
      path.moveTo(0, y);
      path.lineTo(900, y);
    }
    return path;
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
                <Path path={gridPath} color="#dce4ed" style="stroke" strokeWidth={1} />
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
