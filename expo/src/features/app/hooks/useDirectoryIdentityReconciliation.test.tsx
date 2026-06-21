import { act, renderHook } from "@testing-library/react-native";
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
        json: async () => ({ basePath: "." }),
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
    expect(result.current).toBe(".");
  });
});
