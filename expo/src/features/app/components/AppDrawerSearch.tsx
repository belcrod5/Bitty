import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { styles } from "../styles";
import type { RegisteredDirectoryEntry } from "../types/directorySessions";
import {
  listDrawerConversationSearchDirectories,
  searchDrawerConversations,
  type DrawerConversationSearchOrder,
  type DrawerConversationSearchResult,
} from "../utils/drawerConversationSearch";

export const APP_DRAWER_SEARCH_INPUT_ACCESSORY_ID = "appDrawerSearchKeyboardAccessory";

type SearchMode = "directory" | "chat";
type SearchAge = "all" | "7" | "30";
type SearchPosition = { directories: string[]; directoryOffset: number; cursor: string; since: string };

const DIRECTORY_PAGE_SIZE = 8;
const POPOVER_BOTTOM_GAP = 12;

function optionLabel(value: SearchAge): string {
  if (value === "7") return "7日以内";
  if (value === "30") return "30日以内";
  return "すべて";
}

function sinceTimestamp(value: SearchAge): string {
  if (value === "all") return "";
  return new Date(Date.now() - Number(value) * 24 * 60 * 60 * 1000).toISOString();
}

function resultDate(value: string | undefined): string {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })
    : "";
}

export function AppDrawerSearch({
  directoryQuery,
  onChangeDirectoryQuery,
  active,
  onActiveChange,
  directoryMatchCount,
  registeredDirectories,
  viewportBottom,
  onSelectChatResult,
}: {
  directoryQuery: string;
  onChangeDirectoryQuery: (query: string) => void;
  active: boolean;
  onActiveChange: (active: boolean) => void;
  directoryMatchCount: number;
  registeredDirectories: RegisteredDirectoryEntry[];
  viewportBottom: number | null;
  onSelectChatResult: (result: DrawerConversationSearchResult, event: GestureResponderEvent) => void;
}) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const { height: windowHeight } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<SearchMode>("directory");
  const [query, setQuery] = useState(directoryQuery);
  const [order, setOrder] = useState<DrawerConversationSearchOrder>("newest");
  const [age, setAge] = useState<SearchAge>("all");
  const [showOptions, setShowOptions] = useState(false);
  const [results, setResults] = useState<DrawerConversationSearchResult[]>([]);
  const [nextPosition, setNextPosition] = useState<SearchPosition | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [searchDirectoryCount, setSearchDirectoryCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState(false);
  const [containerY, setContainerY] = useState<number | null>(null);
  const [popoverY, setPopoverY] = useState<number | null>(null);
  const normalizedQuery = query.trim();
  const popoverHeight = viewportBottom === null || containerY === null || popoverY === null
    ? Math.max(0, windowHeight / 2)
    : Math.max(0, viewportBottom - containerY - popoverY - POPOVER_BOTTOM_GAP);
  const registeredDirectoryPaths = useMemo(() => new Set(
    registeredDirectories.map((entry) => String(entry.path || "").trim()).filter(Boolean)
  ), [registeredDirectories]);

  const invalidateSearch = useCallback(() => {
    abortRef.current?.abort();
    requestRef.current += 1;
    setLoading(false);
    setLoadingMore(false);
    setHasSubmitted(false);
    setSearchDirectoryCount(null);
    setResults([]);
    setNextPosition(null);
    setError("");
    setPartial(false);
  }, []);

  const updateContainerY = useCallback((event: LayoutChangeEvent) => {
    setContainerY(event.nativeEvent.layout.y);
  }, []);

  const updatePopoverY = useCallback((event: LayoutChangeEvent) => {
    setPopoverY(event.nativeEvent.layout.y);
  }, []);

  const executeSearch = useCallback(async (position: SearchPosition, append: boolean) => {
    const directoryPage = position.directories.slice(
      position.directoryOffset,
      position.directoryOffset + DIRECTORY_PAGE_SIZE
    );
    if (directoryPage.length <= 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setHasSubmitted(true);
    setError("");
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const page = await searchDrawerConversations({
        runnerUrl,
        runnerToken,
        query: normalizedQuery,
        directories: directoryPage,
        backendId: "all",
        order,
        since: position.since,
        cursor: position.cursor,
        signal: controller.signal,
      });
      if (requestRef.current !== requestId) return;
      setResults((current) => {
        const combined = append ? [...current, ...page.results] : page.results;
        const seen = new Set<string>();
        return combined.filter((result) => {
          const key = `${result.sessionRef?.backendId}:${result.sessionRef?.nativeSessionId}:${result.messageId}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
      setPartial((current) => (append ? current : false) || page.partial);
      setNextPosition(page.cursor
        ? { ...position, cursor: page.cursor }
        : position.directoryOffset + DIRECTORY_PAGE_SIZE < position.directories.length
          ? { ...position, directoryOffset: position.directoryOffset + DIRECTORY_PAGE_SIZE, cursor: "" }
          : null);
    } catch (searchError) {
      if (requestRef.current !== requestId || controller.signal.aborted) return;
      setError(searchError instanceof Error ? searchError.message : "検索に失敗しました。");
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [normalizedQuery, order, runnerToken, runnerUrl]);

  useEffect(() => {
    invalidateSearch();
    return () => {
      abortRef.current?.abort();
      requestRef.current += 1;
    };
  }, [active, invalidateSearch, mode, registeredDirectoryPaths, runnerToken, runnerUrl]);

  const selectMode = (nextMode: SearchMode) => {
    invalidateSearch();
    setMode(nextMode);
    setQuery("");
    onChangeDirectoryQuery("");
    inputRef.current?.focus();
  };

  const changeQuery = (value: string) => {
    if (mode === "chat") invalidateSearch();
    setQuery(value);
    if (mode === "directory") onChangeDirectoryQuery(value);
  };

  const changeOrder = (value: DrawerConversationSearchOrder) => {
    if (value === order) return;
    invalidateSearch();
    setOrder(value);
  };

  const changeAge = (value: SearchAge) => {
    if (value === age) return;
    invalidateSearch();
    setAge(value);
  };

  const prepareSearch = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setHasSubmitted(true);
    setLoading(true);
    setLoadingMore(false);
    setResults([]);
    setNextPosition(null);
    setError("");
    setPartial(false);
    try {
      const searchableDirectories = await listDrawerConversationSearchDirectories({
        runnerUrl,
        runnerToken,
        signal: controller.signal,
      });
      if (requestRef.current !== requestId) return;
      const directories = searchableDirectories.filter((directory) => registeredDirectoryPaths.has(directory));
      setSearchDirectoryCount(directories.length);
      if (directories.length <= 0) {
        setLoading(false);
        return;
      }
      void executeSearch({
        directories,
        directoryOffset: 0,
        cursor: "",
        since: sinceTimestamp(age),
      }, false);
    } catch (searchError) {
      if (requestRef.current !== requestId || controller.signal.aborted) return;
      setError(searchError instanceof Error ? searchError.message : "検索に失敗しました。");
      setLoading(false);
    }
  };

  const submitSearch = () => {
    if (mode === "chat") {
      Keyboard.dismiss();
      if (normalizedQuery.length >= 2) void prepareSearch();
      return;
    }
    onActiveChange(false);
    Keyboard.dismiss();
  };

  return (
    <View
      style={styles.appDrawerSearchContainer}
      onLayout={updateContainerY}
      testID="app-drawer-search-container"
    >
      <View style={[styles.appDrawerSearchBox, active && styles.appDrawerSearchBoxFocused]}>
        <TextInput
          ref={inputRef}
          style={styles.appDrawerSearchInput}
          value={query}
          onChangeText={changeQuery}
          onFocus={() => onActiveChange(true)}
          placeholder={mode === "directory" ? "ディレクトリを検索" : "チャット内を検索"}
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="never"
          inputAccessoryViewID={Platform.OS === "ios" ? APP_DRAWER_SEARCH_INPUT_ACCESSORY_ID : undefined}
          onSubmitEditing={submitSearch}
          returnKeyType="search"
          submitBehavior="blurAndSubmit"
          accessibilityLabel={mode === "directory" ? "ディレクトリ検索" : "チャット検索"}
        />
        {query ? (
          <TouchableOpacity
            style={styles.appDrawerSearchClearButton}
            onPress={() => changeQuery("")}
            accessibilityRole="button"
            accessibilityLabel="検索をクリア"
          >
            <Text style={styles.appDrawerSearchClearButtonText}>×</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {active ? (
        <View
          style={[
            styles.appDrawerSearchPopover,
            mode === "chat"
              ? { height: popoverHeight }
              : styles.appDrawerSearchPopoverCompact,
          ]}
          onLayout={updatePopoverY}
          testID="app-drawer-search-popover"
        >
          <View style={styles.appDrawerSearchTabs} accessibilityRole="tablist">
            {(["directory", "chat"] as const).map((tab) => (
              <Pressable
                key={tab}
                style={[styles.appDrawerSearchTab, mode === tab && styles.appDrawerSearchTabSelected]}
                onPress={() => selectMode(tab)}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === tab }}
              >
                <Text style={[
                  styles.appDrawerSearchTabText,
                  mode === tab && styles.appDrawerSearchTabTextSelected,
                ]}>
                  {tab === "directory" ? "ディレクトリ" : "チャット"}
                </Text>
              </Pressable>
            ))}
            <Pressable
              style={styles.appDrawerSearchDismissButton}
              onPress={() => {
                onActiveChange(false);
                Keyboard.dismiss();
              }}
              accessibilityRole="button"
              accessibilityLabel="検索を閉じる"
            >
              <Text style={styles.appDrawerSearchDismissButtonText}>×</Text>
            </Pressable>
          </View>
          {mode === "directory" ? (
            <View style={styles.appDrawerSearchDirectoryStatus}>
              <Text style={styles.appDrawerSearchStatusText}>
                {normalizedQuery
                  ? `${directoryMatchCount}件の登録ディレクトリに一致`
                  : `登録ディレクトリ ${registeredDirectories.length}件を名前・パスで絞り込み`}
              </Text>
            </View>
          ) : (
            <ScrollView
              style={styles.appDrawerSearchResults}
              contentContainerStyle={styles.appDrawerSearchResultsContent}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              testID="app-drawer-search-results"
            >
              <Pressable
                style={styles.appDrawerSearchOptionsSummary}
                onPress={() => setShowOptions((current) => !current)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showOptions }}
              >
                <Text style={styles.appDrawerSearchOptionsSummaryText}>検索オプション</Text>
                <Text style={styles.appDrawerSearchOptionsValue}>
                  {`${order === "newest" ? "新しい順" : "古い順"}・${optionLabel(age)}`}
                </Text>
              </Pressable>
              {showOptions ? (
                <View style={styles.appDrawerSearchOptions}>
                  <Text style={styles.appDrawerSearchOptionLabel}>並び順</Text>
                  <View style={styles.appDrawerSearchOptionRow}>
                    {(["newest", "oldest"] as const).map((value) => (
                      <Pressable
                        key={value}
                        style={[styles.appDrawerSearchChip, order === value && styles.appDrawerSearchChipSelected]}
                        onPress={() => changeOrder(value)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: order === value }}
                      >
                        <Text style={styles.appDrawerSearchChipText}>{value === "newest" ? "新しい順" : "古い順"}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.appDrawerSearchOptionLabel}>期間</Text>
                  <View style={styles.appDrawerSearchOptionRow}>
                    {(["all", "7", "30"] as const).map((value) => (
                      <Pressable
                        key={value}
                        style={[styles.appDrawerSearchChip, age === value && styles.appDrawerSearchChipSelected]}
                        onPress={() => changeAge(value)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: age === value }}
                      >
                        <Text style={styles.appDrawerSearchChipText}>{optionLabel(value)}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}
              <Text style={styles.appDrawerSearchScopeText}>
                {searchDirectoryCount === null
                  ? `登録済みディレクトリ ${registeredDirectories.length}件`
                  : `検索可能なディレクトリ ${searchDirectoryCount}件を順に検索`}
              </Text>
              {normalizedQuery.length < 2 ? (
                  <Text style={styles.appDrawerSearchStatusText}>2文字以上入力してください。</Text>
                ) : hasSubmitted && searchDirectoryCount === 0 ? (
                  <Text style={styles.appDrawerSearchStatusText}>検索対象の登録ディレクトリがありません。</Text>
                ) : !hasSubmitted ? (
                  <Text style={styles.appDrawerSearchStatusText}>検索キーで検索します。</Text>
                ) : loading ? (
                  <View style={styles.appDrawerSearchLoading} accessibilityRole="progressbar">
                    <ActivityIndicator size="small" color="#0f766e" />
                    <Text style={styles.appDrawerSearchStatusText}>チャットを検索しています…</Text>
                  </View>
                ) : error && results.length <= 0 ? (
                  <View>
                    <Text style={styles.appDrawerSearchError} accessibilityRole="alert">{error}</Text>
                    <Pressable
                      style={styles.appDrawerSearchMoreButton}
                      onPress={() => void submitSearch()}
                      accessibilityRole="button"
                    >
                      <Text style={styles.appDrawerSearchMoreButtonText}>再試行</Text>
                    </Pressable>
                  </View>
                ) : results.length <= 0 ? (
                  <Text style={styles.appDrawerSearchStatusText}>一致するチャットはありません。</Text>
                ) : results.map((result) => (
                  <Pressable
                    key={`${result.sessionRef.backendId}:${result.sessionRef.nativeSessionId}:${result.messageId}`}
                    style={styles.appDrawerSearchResult}
                    onPress={(event) => {
                      onActiveChange(false);
                      Keyboard.dismiss();
                      onSelectChatResult(result, event);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${result.role === "user" ? "ユーザー" : "アシスタント"}の検索結果 ${result.snippet}`}
                  >
                    <View style={styles.appDrawerSearchResultMetaRow}>
                      <Text style={styles.appDrawerSearchResultRole}>
                        {result.role === "user" ? "ユーザー" : "アシスタント"}
                      </Text>
                      <Text style={styles.appDrawerSearchResultMeta} numberOfLines={1}>
                        {`${result.sessionRef.backendId} ${resultDate(result.createdAt || result.sessionCreatedAt)}`.trim()}
                      </Text>
                    </View>
                    <Text style={styles.appDrawerSearchResultSnippet} numberOfLines={3}>{result.snippet}</Text>
                    <Text style={styles.appDrawerSearchResultPath} numberOfLines={1}>{result.canonicalCwd}</Text>
                  </Pressable>
                ))}
                {error && results.length > 0 ? (
                  <Text style={styles.appDrawerSearchError} accessibilityRole="alert">{error}</Text>
                ) : null}
                {partial ? <Text style={styles.appDrawerSearchWarning}>一部のバックエンドを検索できませんでした。</Text> : null}
                {nextPosition && !loading ? (
                  <Pressable
                    style={styles.appDrawerSearchMoreButton}
                    disabled={loadingMore}
                    onPress={() => void executeSearch(nextPosition, true)}
                    accessibilityRole="button"
                  >
                    {loadingMore ? <ActivityIndicator size="small" color="#1e40af" /> : null}
                    <Text style={styles.appDrawerSearchMoreButtonText}>検索を続ける</Text>
                  </Pressable>
                ) : null}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}
