import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Image,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { ResizeMode, Video } from "expo-av";
import { Ionicons } from "@expo/vector-icons";
import {
  GestureViewer,
  useGestureViewerController,
  useGestureViewerState,
} from "react-native-gesture-image-viewer";
import { WorkspaceFileRenameDialog } from "./WorkspaceFileRenameDialog";
import type { RunnerMediaFile, RunnerMediaItem } from "../utils/runnerFileContextMenu";
import type { WorkspaceFileTarget } from "../utils/workspaceFiles";

type RunnerMediaViewerProps = {
  media: RunnerMediaFile | null;
  onRequestClose: () => void;
};

const RUNNER_MEDIA_VIEWER_ID = "runner-media-viewer";
const VIEWER_HEADER_HEIGHT = 64;
const VIEWER_THUMBNAIL_HEIGHT = 94;

export function RunnerMediaViewer({ media, onRequestClose }: RunnerMediaViewerProps) {
  const [error, setError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [renameTarget, setRenameTarget] = useState<WorkspaceFileTarget | null>(null);
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { goToIndex } = useGestureViewerController(RUNNER_MEDIA_VIEWER_ID);
  const viewerState = useGestureViewerState(RUNNER_MEDIA_VIEWER_ID);

  const items = useMemo<RunnerMediaItem[]>(() => {
    if (!media) return [];
    const next: RunnerMediaItem[] = [];
    const seen = new Set<string>();
    const pushItem = (itemRaw: RunnerMediaItem | null | undefined) => {
      if (!itemRaw?.path || !itemRaw.url || seen.has(itemRaw.path)) return;
      seen.add(itemRaw.path);
      next.push(itemRaw);
    };
    for (const item of media.items || []) {
      pushItem(item);
    }
    pushItem(media);
    return next;
  }, [media]);

  const initialIndex = useMemo(() => {
    if (!media || items.length <= 0) return 0;
    const rawIndex = Number(media.initialIndex);
    if (Number.isFinite(rawIndex) && rawIndex >= 0 && rawIndex < items.length) {
      return Math.floor(rawIndex);
    }
    const pathIndex = items.findIndex((item) => item.path === media.path);
    return pathIndex >= 0 ? pathIndex : 0;
  }, [items, media]);

  const activeIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
  const activeItem = items[activeIndex] || items[initialIndex] || media;
  const viewerWidth = Math.max(1, Math.floor(contentSize.width || screenWidth));
  const viewerHeight = Math.max(
    220,
    Math.floor(contentSize.height || (screenHeight - VIEWER_HEADER_HEIGHT))
  );

  const toggleControlsVisible = useCallback(() => {
    setControlsVisible((visible) => !visible);
  }, []);

  useEffect(() => {
    setError("");
    setSelectedIndex(initialIndex);
    setControlsVisible(true);
    setRenameTarget(null);
  }, [initialIndex, media?.path]);

  useEffect(() => {
    if (viewerState.totalCount <= 0) return;
    setSelectedIndex(Math.max(0, Math.min(viewerState.totalCount - 1, viewerState.currentIndex)));
  }, [viewerState.currentIndex, viewerState.totalCount]);

  useEffect(() => {
    setError("");
  }, [activeItem?.url]);

  const sourceForItem = useCallback((item: RunnerMediaItem) => ({
    uri: item.url,
    headers: media?.runnerToken
      ? {
        authorization: `Bearer ${media.runnerToken}`,
      }
      : undefined,
  }), [media?.runnerToken]);

  const renderMediaItem = useCallback((item: RunnerMediaItem, index: number) => {
    const source = sourceForItem(item);
    if (item.kind === "video") {
      return (
        <Video
          key={item.url}
          source={source}
          style={viewerStyles.media}
          resizeMode={ResizeMode.CONTAIN}
          useNativeControls
          shouldPlay={index === selectedIndex}
          onError={(message) => {
            setError(message || "動画を再生できませんでした。");
          }}
        />
      );
    }
    return (
      <Image
        key={item.url}
        source={source}
        style={viewerStyles.media}
        resizeMode="contain"
        onError={(event) => {
          setError(event.nativeEvent.error || "画像を表示できませんでした。");
        }}
      />
    );
  }, [selectedIndex, sourceForItem]);

  const openThumbnail = useCallback((index: number) => {
    setSelectedIndex(index);
    goToIndex(index);
  }, [goToIndex]);

  const openActiveContextMenu = useCallback(() => {
    if (!activeItem || !media?.openContextMenuForItem) return;
    media.openContextMenuForItem(activeItem, {
      onRequestRename: media.renameFile ? setRenameTarget : undefined,
    });
  }, [activeItem, media]);

  const renameMediaFile = useCallback(async (nextName: string) => {
    if (!renameTarget || !media?.renameFile) return;
    await media.renameFile(renameTarget, nextName);
    setRenameTarget(null);
  }, [media, renameTarget]);

  const handleContentLayout = useCallback((event: {
    nativeEvent: { layout: { width: number; height: number } };
  }) => {
    const width = Math.floor(event.nativeEvent.layout.width);
    const height = Math.floor(event.nativeEvent.layout.height);
    setContentSize((current) => (
      current.width === width && current.height === height
        ? current
        : { width, height }
    ));
  }, []);

  const renderThumbnail = useCallback((item: RunnerMediaItem, index: number) => {
    const selected = index === activeIndex;
    return (
      <TouchableOpacity
        key={`${item.path}:${index}`}
        style={[
          viewerStyles.thumbnailButton,
          selected ? viewerStyles.thumbnailButtonActive : null,
        ]}
        onPress={() => openThumbnail(index)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}を表示`}
      >
        {item.kind === "image" ? (
          <Image
            source={sourceForItem(item)}
            style={viewerStyles.thumbnailImage}
            resizeMode="cover"
          />
        ) : (
          <View style={viewerStyles.thumbnailVideo}>
            <Ionicons name="play" size={18} color="#e2e8f0" />
          </View>
        )}
        <Text style={viewerStyles.thumbnailLabel} numberOfLines={1}>{item.name}</Text>
      </TouchableOpacity>
    );
  }, [activeIndex, openThumbnail, sourceForItem]);

  const viewerKey = media
    ? `${media.path}:${items.length}:${initialIndex}`
    : "empty";

  if (!media) {
    return null;
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onRequestClose}
    >
      <SafeAreaView style={viewerStyles.root}>
        <View style={viewerStyles.header}>
          <View style={viewerStyles.titleWrap}>
            <Text style={viewerStyles.title} numberOfLines={1}>{activeItem?.name || "Media"}</Text>
            <Text style={viewerStyles.path} numberOfLines={1}>
              {items.length > 1
                ? `${activeIndex + 1}/${items.length}  ${activeItem?.path || ""}`
                : activeItem?.path || ""}
            </Text>
          </View>
          {media.openContextMenuForItem && activeItem ? (
            <TouchableOpacity
              style={viewerStyles.closeButton}
              onPress={openActiveContextMenu}
              accessibilityRole="button"
              accessibilityLabel="メディアの操作メニューを開く"
            >
              <Ionicons name="ellipsis-horizontal" size={24} color="#e2e8f0" />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={viewerStyles.closeButton}
            onPress={onRequestClose}
            accessibilityRole="button"
            accessibilityLabel="メディアビューアーを閉じる"
          >
            <Ionicons name="close" size={24} color="#e2e8f0" />
          </TouchableOpacity>
        </View>
        <View style={viewerStyles.content} onLayout={handleContentLayout}>
          {items.length > 0 && contentSize.height > 0 ? (
            <GestureViewer
              key={viewerKey}
              id={RUNNER_MEDIA_VIEWER_ID}
              data={items}
              initialIndex={initialIndex}
              renderItem={renderMediaItem}
              ListComponent={ScrollView}
              width={viewerWidth}
              height={viewerHeight}
              maxZoomScale={6}
              enablePinchZoom
              enableDoubleTapZoom
              enablePanWhenZoomed
              enableHorizontalSwipe
              onSingleTap={toggleControlsVisible}
              dismiss={{ enabled: false }}
              backdropStyle={viewerStyles.viewerBackdrop}
              containerStyle={viewerStyles.viewerContainer}
            />
          ) : null}
          {error ? <Text style={viewerStyles.error}>{error}</Text> : null}
        </View>
        {controlsVisible && items.length > 1 ? (
          <View style={viewerStyles.thumbnailStrip}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={viewerStyles.thumbnailStripContent}
            >
              {items.map(renderThumbnail)}
            </ScrollView>
          </View>
        ) : null}
        <WorkspaceFileRenameDialog
          target={renameTarget}
          onCancel={() => setRenameTarget(null)}
          onRename={renameMediaFile}
        />
      </SafeAreaView>
    </Modal>
  );
}

const viewerStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#020617",
  },
  header: {
    minHeight: VIEWER_HEADER_HEIGHT,
    paddingLeft: 16,
    paddingRight: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#334155",
    flexDirection: "row",
    alignItems: "center",
  },
  titleWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "700",
  },
  path: {
    marginTop: 2,
    color: "#94a3b8",
    fontSize: 11,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  viewerBackdrop: {
    backgroundColor: "#020617",
  },
  viewerContainer: {
    backgroundColor: "#020617",
  },
  media: {
    width: "100%",
    height: "100%",
  },
  thumbnailStrip: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: VIEWER_THUMBNAIL_HEIGHT,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#334155",
    justifyContent: "center",
    backgroundColor: "#020617",
  },
  thumbnailStripContent: {
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 8,
  },
  thumbnailButton: {
    width: 66,
    height: 72,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
    overflow: "hidden",
    backgroundColor: "#0f172a",
  },
  thumbnailButtonActive: {
    borderColor: "#38bdf8",
  },
  thumbnailImage: {
    width: "100%",
    height: 50,
    backgroundColor: "#111827",
  },
  thumbnailVideo: {
    width: "100%",
    height: 50,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1e293b",
  },
  thumbnailLabel: {
    color: "#cbd5e1",
    fontSize: 9,
    lineHeight: 16,
    paddingHorizontal: 4,
  },
  error: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 24,
    color: "#fecaca",
    backgroundColor: "rgba(127, 29, 29, 0.92)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlign: "center",
  },
});
