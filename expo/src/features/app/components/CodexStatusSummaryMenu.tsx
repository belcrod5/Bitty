import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, Pressable, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useAppStyles } from "../styles";
import { AppModal } from "./AppModal";
import { formatCodexAuthRateLimits, parseCodexStatusLimit } from "../utils/codexAuthRateLimits";
import { useChatDiagnostics } from "../contexts/ChatDiagnosticsContext";
import { useVisualTheme } from "../theme/VisualThemeContext";

type AnchorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CodexStatusSummaryMenuProps = {
  dismissed?: boolean;
  compact?: boolean;
};

const STATUS_PREVIEW_WIDTH = 320;

export function CodexStatusSummaryMenu({
  dismissed = false,
  compact = false,
}: CodexStatusSummaryMenuProps) {
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const {
    codexCliStatusText: statusText,
    codexCliStatusRateLimits: statusRateLimits,
    codexUsageLimitReached: usageLimitReached,
    codexCliStatusLoading: statusLoading,
    codexAuthProfileId: authProfileId,
    codexAuthProfiles: authProfiles,
    codexAuthProfilesLoading: authProfilesLoading,
    codexAuthSwitching: authSwitching,
    codexAuthSwitchError: authSwitchError,
    loadCodexAuthProfiles: onLoadAuthProfiles,
    switchCodexAuthProfile: onSwitchAuthProfile,
  } = useChatDiagnostics();
  const triggerRef = useRef<View | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [authSelectOpen, setAuthSelectOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect>({ x: 0, y: 0, width: 0, height: 0 });
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    if (compact) return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 30 * 1000);
    return () => clearInterval(timer);
  }, [compact]);
  useEffect(() => {
    if (!dismissed) return;
    setAuthSelectOpen(false);
    setPreviewOpen(false);
  }, [dismissed]);

  const statusFullText = String(statusText || "").trim();
  const authProfileItems = useMemo(
    () => (Array.isArray(authProfiles) ? authProfiles : []),
    [authProfiles]
  );
  const fiveHourLimit = parseCodexStatusLimit(statusFullText, "5h");
  const weeklyLimit = parseCodexStatusLimit(statusFullText, "Weekly");
  const weeklyReset = formatCodexAuthRateLimits({ rateLimits: statusRateLimits }, nowMs).weeklyReset;
  const fiveHourPct = fiveHourLimit.remainingPercent ?? "--";
  const weeklyPct = weeklyLimit.remainingPercent ?? "--";
  const currentAuthId = String(authProfileId || "").trim();
  const currentDisplayName = String(authProfileItems.find((item) => item.authId === currentAuthId)?.displayName || "").trim();
  const currentAuthIdText = currentDisplayName || currentAuthId || "(未選択)";

  const closePreview = useCallback(() => {
    setAuthSelectOpen(false);
    setPreviewOpen(false);
  }, []);

  const openPreview = useCallback(() => {
    const openWithRefresh = () => {
      setPreviewOpen(true);
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
  }, [onLoadAuthProfiles]);

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
  const previewWidth = Math.min(STATUS_PREVIEW_WIDTH, screenWidth - 16);
  const previewLeft = Math.max(
    8,
    Math.min(
      anchor.x + anchor.width - previewWidth,
      Math.max(8, screenWidth - previewWidth - 8)
    )
  );
  const previewTop = Math.max(8, anchor.y - previewEstimatedHeight - 6);
  const fiveHourSummary = (
    <Text
      style={[styles.chatStatusSummaryText, compact && { lineHeight: 16 }, { color: theme.tones[fiveHourLimit.tone].foreground }]}
      numberOfLines={1}
      accessibilityLabel={`5時間の残り ${fiveHourPct}%`}
    >{fiveHourPct}%</Text>
  );
  const weeklySummary = (
    <Text
      style={[styles.chatStatusSummaryText, compact && { lineHeight: 16 }, { color: theme.tones[weeklyLimit.tone].foreground }]}
      numberOfLines={1}
      accessibilityLabel={`週間の残り ${weeklyPct}%`}
    >{weeklyPct}%</Text>
  );
  const usageLimitSummary = usageLimitReached && fiveHourLimit.remainingPercent !== 0 && weeklyLimit.remainingPercent !== 0 ? (
    <Text style={[styles.chatStatusSummaryText, { color: theme.tones.danger.foreground }]} accessibilityLabel="Codex 利用上限">利用上限</Text>
  ) : null;

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        <TouchableOpacity
          onPress={openPreview}
          disabled={dismissed}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="利用状況を更新して表示"
        >
          {compact ? (
            usageLimitSummary || <>
              {fiveHourSummary}
              {weeklySummary}
            </>
          ) : (
            <Text style={styles.chatStatusSummaryText} numberOfLines={1}>
              {usageLimitSummary || <>5h {fiveHourSummary} | 週 {weeklySummary}</>}
              {weeklyReset ? (
                <> | <Text style={weeklyReset.tone === "danger" && { color: theme.tones.danger.foreground }}>{weeklyReset.text}</Text></>
              ) : null}
              {statusLoading ? " 更新中..." : ""}
            </Text>
          )}
        </TouchableOpacity>
      </View>
      <AppModal
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
                width: previewWidth,
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
                      const limits = formatCodexAuthRateLimits(item);
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
                            {isCurrent ? "✓ " : ""}{String(item?.displayName || "").trim() || authId}
                          </Text>
                          {limits.text ? (
                            <Text
                              numberOfLines={1}
                              style={[styles.chatStatusAuthOptionLimits, isCurrent && styles.chatFooterSelectOptionTextSelected]}
                            >
                              {limits.text}
                              {limits.weeklyReset ? (
                                <> | <Text style={limits.weeklyReset.tone === "danger" && { color: theme.tones.danger.foreground }}>{limits.weeklyReset.text}</Text></>
                              ) : null}
                            </Text>
                          ) : null}
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
      </AppModal>
    </>
  );
}
