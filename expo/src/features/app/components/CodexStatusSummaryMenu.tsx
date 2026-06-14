import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { styles } from "../styles";
import type { CodexAuthProfileEntry } from "../types/appTypes";

type AnchorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CodexStatusSummaryMenuProps = {
  dismissed?: boolean;
  statusText: string;
  statusFetchedAtMs: number;
  statusLoading?: boolean;
  authProfileId?: string;
  authProfiles?: readonly CodexAuthProfileEntry[];
  authProfilesLoading?: boolean;
  authSwitching?: boolean;
  authSwitchError?: string;
  onRefreshStatus?: () => void;
  onLoadAuthProfiles?: () => void;
  onSwitchAuthProfile?: (authId: string) => Promise<boolean> | boolean;
};

const STATUS_PREVIEW_WIDTH = 236;

function parseLimitPct(statusFullText: string, label: "5h" | "Weekly") {
  const match = statusFullText.match(new RegExp(`${label} limit:[^\\n]*?(\\d+)%\\s*left`, "i"));
  return match?.[1] || "--";
}

function formatStatusElapsed(statusFetchedAtMs: number, tick: number) {
  void tick;
  if (statusFetchedAtMs <= 0) return "未取得";
  const elapsedMs = Math.max(0, Date.now() - statusFetchedAtMs);
  const elapsedMin = Math.floor(elapsedMs / 60000);
  if (elapsedMin <= 0) return "たった今";
  if (elapsedMin < 60) return `${elapsedMin}分前`;
  const elapsedHour = Math.floor(elapsedMin / 60);
  return `${elapsedHour}時間前`;
}

export function CodexStatusSummaryMenu({
  dismissed = false,
  statusText,
  statusFetchedAtMs,
  statusLoading = false,
  authProfileId = "",
  authProfiles = [],
  authProfilesLoading = false,
  authSwitching = false,
  authSwitchError = "",
  onRefreshStatus,
  onLoadAuthProfiles,
  onSwitchAuthProfile,
}: CodexStatusSummaryMenuProps) {
  const triggerRef = useRef<View | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [authSelectOpen, setAuthSelectOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect>({ x: 0, y: 0, width: 0, height: 0 });
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowTick((prev) => prev + 1);
    }, 30 * 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!dismissed) return;
    setAuthSelectOpen(false);
    setPreviewOpen(false);
  }, [dismissed]);

  const statusFullText = String(statusText || "").trim();
  const normalizedFetchedAtMs = Number(statusFetchedAtMs || 0);
  const safeFetchedAtMs = Number.isFinite(normalizedFetchedAtMs) ? normalizedFetchedAtMs : 0;
  const authProfileItems = useMemo(
    () => (Array.isArray(authProfiles) ? authProfiles : []),
    [authProfiles]
  );
  const fiveHourPct = parseLimitPct(statusFullText, "5h");
  const weeklyPct = parseLimitPct(statusFullText, "Weekly");
  const statusSummaryText = `5h ${fiveHourPct}% | 週 ${weeklyPct}% (${formatStatusElapsed(safeFetchedAtMs, nowTick)})`;
  const currentAuthIdText = String(authProfileId || "").trim() || "(未選択)";

  const closePreview = useCallback(() => {
    setAuthSelectOpen(false);
    setPreviewOpen(false);
  }, []);

  const openPreview = useCallback(() => {
    const openWithRefresh = () => {
      setPreviewOpen(true);
      onRefreshStatus?.();
      onLoadAuthProfiles?.();
    };
    if (!triggerRef.current || typeof triggerRef.current.measureInWindow !== "function") {
      openWithRefresh();
      return;
    }
    triggerRef.current.measureInWindow((x, y, width, height) => {
      setAnchor({
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
      });
      openWithRefresh();
    });
  }, [onLoadAuthProfiles, onRefreshStatus]);

  const toggleAuthSelect = useCallback(() => {
    setAuthSelectOpen((prev) => {
      const nextOpen = !prev;
      if (nextOpen) onLoadAuthProfiles?.();
      return nextOpen;
    });
  }, [onLoadAuthProfiles]);

  const previewLineCount = Math.max(2, statusFullText ? statusFullText.split("\n").length : 2);
  const authPanelEstimatedHeight = authSelectOpen
    ? Math.min(240, Math.max(56, (authProfileItems.length * 34) + 48))
    : 0;
  const previewEstimatedHeight = Math.max(84, previewLineCount * 16 + 18 + authPanelEstimatedHeight);
  const screenWidth = Dimensions.get("window").width;
  const previewLeft = Math.max(
    8,
    Math.min(
      anchor.x + anchor.width - STATUS_PREVIEW_WIDTH,
      Math.max(8, screenWidth - STATUS_PREVIEW_WIDTH - 8)
    )
  );
  const previewTop = Math.max(8, anchor.y - previewEstimatedHeight - 6);

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        <TouchableOpacity
          onPress={openPreview}
          disabled={dismissed}
          accessibilityRole="button"
          accessibilityLabel="利用状況を更新して表示"
        >
          <Text style={styles.chatStatusSummaryText}>
            {statusSummaryText}
            {statusLoading ? " 更新中..." : ""}
          </Text>
        </TouchableOpacity>
      </View>
      <Modal
        visible={previewOpen && !dismissed}
        transparent
        animationType="fade"
        onRequestClose={closePreview}
      >
        <Pressable style={styles.chatFooterSelectBackdrop} onPress={closePreview}>
          <Pressable
            style={[
              styles.chatStatusPreviewCard,
              {
                left: previewLeft,
                top: previewTop,
              },
            ]}
            onPress={() => {}}
          >
            <Text style={styles.chatStatusPreviewTitle}>/status</Text>
            <TouchableOpacity
              style={styles.chatStatusAuthRow}
              onPress={toggleAuthSelect}
              accessibilityRole="button"
              accessibilityLabel="認証アカウントを切り替える"
              disabled={!!authSwitching}
            >
              <Text style={styles.chatStatusAuthLabel}>auth</Text>
              <Text style={styles.chatStatusAuthValue}>
                {currentAuthIdText}
                {authProfilesLoading ? " (読込中)" : ""}
                {authSwitching ? " (切替中)" : ""}
              </Text>
            </TouchableOpacity>
            {authSelectOpen ? (
              <View style={styles.chatStatusAuthSelectInlinePanel}>
                {authProfileItems.length > 0 ? (
                  <ScrollView style={styles.chatStatusAuthSelectInlineList} nestedScrollEnabled>
                    {authProfileItems.map((item) => {
                      const authId = String(item?.authId || "").trim();
                      if (!authId) return null;
                      const isCurrent = Boolean(item?.isCurrent);
                      return (
                        <TouchableOpacity
                          key={authId}
                          style={[styles.chatFooterSelectOption, isCurrent && styles.chatFooterSelectOptionSelected]}
                          disabled={!!authSwitching}
                          onPress={() => {
                            if (isCurrent) {
                              setAuthSelectOpen(false);
                              return;
                            }
                            void (async () => {
                              const switched = await onSwitchAuthProfile?.(authId);
                              if (switched) closePreview();
                            })();
                          }}
                        >
                          <Text style={[styles.chatFooterSelectOptionText, isCurrent && styles.chatFooterSelectOptionTextSelected]}>
                            {isCurrent ? `✓ ${authId}` : authId}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                ) : (
                  <Text style={styles.chatStatusAuthEmptyText}>
                    {authProfilesLoading ? "読み込み中..." : "profiles が見つかりません"}
                  </Text>
                )}
              </View>
            ) : null}
            {authSwitchError ? (
              <Text style={styles.chatStatusAuthErrorText}>{authSwitchError}</Text>
            ) : null}
            <Text style={styles.chatStatusPreviewText}>
              {statusFullText || "取得に失敗しました。タップで再取得してください。"}
            </Text>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
