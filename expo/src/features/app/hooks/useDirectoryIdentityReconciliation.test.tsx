import { act, renderHook } from "@testing-library/react-native";
import { Alert } from "react-native";
import { useRef, useState } from "react";
import { useDirectoryIdentityReconciliation } from "./useDirectoryIdentityReconciliation";
import type { DirectorySessionTreeState, RegisteredDirectoryEntry } from "../components/AppDrawer";
import type { GitChangedFilesDirectoryState } from "../types/appTypes";

describe("useDirectoryIdentityReconciliation", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retries the same identity request after a network failure", async () => {
    jest.useFakeTimers();
    jest.spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ basePath: "/real/workspace/bitty" }),
      } as Response);
    const auxServerBaseUrl = () => "http://runner.test";

    const { result } = await renderHook(() => {
      const [selectedDirectory, setSelectedDirectory] = useState("/workspace/bitty");
      const [registeredDirectories, setRegisteredDirectories] = useState<RegisteredDirectoryEntry[]>([]);
      const [, setExpandedDirectoryIds] = useState<string[]>([]);
      const [, setDirectorySessionsById] = useState<Record<string, DirectorySessionTreeState>>({});
      const [, setGitChangedFilesByDirectory] = useState<Record<string, GitChangedFilesDirectoryState>>({});
      const [, setPanelRuntimeEntriesById] = useState({});
      const llmSessionDirectoryRef = useRef(selectedDirectory);
      const gitChangedFilesByDirectoryRef = useRef<Record<string, GitChangedFilesDirectoryState>>({});
      const gitChangedFilesRefreshInFlightRef = useRef(new Map<string, number>());
      const directoryIdentityGenerationRef = useRef(0);
      useDirectoryIdentityReconciliation({
        settingsLoaded: true,
        auxServerBaseUrl,
        runnerToken: "token",
        selectedDirectory,
        registeredDirectories,
        setSelectedDirectory,
        setRegisteredDirectories,
        setExpandedDirectoryIds,
        setDirectorySessionsById,
        setGitChangedFilesByDirectory,
        setPanelRuntimeEntriesById,
        llmSessionDirectoryRef,
        gitChangedFilesByDirectoryRef,
        gitChangedFilesRefreshInFlightRef,
        directoryIdentityGenerationRef,
      });
      return selectedDirectory;
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    // 2回目で正規化し、3回目は正規ID自体が安定していることを確認する。
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result.current).toBe("/real/workspace/bitty");
  });

  it("migrates an existing relative registration to its absolute identity", async () => {
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "更新")?.onPress?.();
    });
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ basePath: "/real/workspace/bitty" }),
    } as Response);
    const auxServerBaseUrl = () => "http://runner.test";

    const { result } = await renderHook(() => {
      const [selectedDirectory, setSelectedDirectory] = useState(".");
      const [registeredDirectories, setRegisteredDirectories] = useState<RegisteredDirectoryEntry[]>([{
        id: "root",
        path: ".",
        displayName: "Bitty",
        markerColor: "gray",
      }]);
      const [, setExpandedDirectoryIds] = useState<string[]>([]);
      const [, setDirectorySessionsById] = useState<Record<string, DirectorySessionTreeState>>({});
      const [, setGitChangedFilesByDirectory] = useState<Record<string, GitChangedFilesDirectoryState>>({});
      const [, setPanelRuntimeEntriesById] = useState({});
      const llmSessionDirectoryRef = useRef(selectedDirectory);
      const gitChangedFilesByDirectoryRef = useRef<Record<string, GitChangedFilesDirectoryState>>({});
      const gitChangedFilesRefreshInFlightRef = useRef(new Map<string, number>());
      const directoryIdentityGenerationRef = useRef(0);
      useDirectoryIdentityReconciliation({
        settingsLoaded: true,
        auxServerBaseUrl,
        runnerToken: "token",
        selectedDirectory,
        registeredDirectories,
        setSelectedDirectory,
        setRegisteredDirectories,
        setExpandedDirectoryIds,
        setDirectorySessionsById,
        setGitChangedFilesByDirectory,
        setPanelRuntimeEntriesById,
        llmSessionDirectoryRef,
        gitChangedFilesByDirectoryRef,
        gitChangedFilesRefreshInFlightRef,
        directoryIdentityGenerationRef,
      });
      return { selectedDirectory, registeredDirectories };
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.selectedDirectory).toBe("/real/workspace/bitty");
    expect(result.current.registeredDirectories).toEqual([{
      id: "root",
      path: "/real/workspace/bitty",
      displayName: "Bitty",
      markerColor: "gray",
    }]);
    expect(Alert.alert).toHaveBeenCalledWith(
      "ディレクトリ登録を更新",
      expect.stringContaining(". → /real/workspace/bitty"),
      expect.any(Array),
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "http://runner.test/directory-identities/migrate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: ".", target: "/real/workspace/bitty" }),
      })
    );
  });

  it("does not persist an ambiguous relative registration without confirmation", async () => {
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "キャンセル")?.onPress?.();
    });
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ basePath: "/wrong/worktree" }),
    } as Response);

    const { result } = await renderHook(() => {
      const [selectedDirectory, setSelectedDirectory] = useState(".");
      const [registeredDirectories, setRegisteredDirectories] = useState<RegisteredDirectoryEntry[]>([{
        id: "root",
        path: ".",
        displayName: "Bitty",
        markerColor: "gray",
      }]);
      const [, setExpandedDirectoryIds] = useState<string[]>([]);
      const [, setDirectorySessionsById] = useState<Record<string, DirectorySessionTreeState>>({});
      const [, setGitChangedFilesByDirectory] = useState<Record<string, GitChangedFilesDirectoryState>>({});
      const [, setPanelRuntimeEntriesById] = useState({});
      const llmSessionDirectoryRef = useRef(selectedDirectory);
      const gitChangedFilesByDirectoryRef = useRef<Record<string, GitChangedFilesDirectoryState>>({});
      const gitChangedFilesRefreshInFlightRef = useRef(new Map<string, number>());
      const directoryIdentityGenerationRef = useRef(0);
      useDirectoryIdentityReconciliation({
        settingsLoaded: true,
        auxServerBaseUrl: () => "http://runner.test",
        runnerToken: "token",
        selectedDirectory,
        registeredDirectories,
        setSelectedDirectory,
        setRegisteredDirectories,
        setExpandedDirectoryIds,
        setDirectorySessionsById,
        setGitChangedFilesByDirectory,
        setPanelRuntimeEntriesById,
        llmSessionDirectoryRef,
        gitChangedFilesByDirectoryRef,
        gitChangedFilesRefreshInFlightRef,
        directoryIdentityGenerationRef,
      });
      return { selectedDirectory, registeredDirectories };
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.selectedDirectory).toBe(".");
    expect(result.current.registeredDirectories[0].path).toBe(".");
  });
});
