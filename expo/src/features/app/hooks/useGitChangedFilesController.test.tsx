import { act, renderHook } from "@testing-library/react-native";
import { useRef, useState } from "react";
import { useGitChangedFilesController } from "./useGitChangedFilesController";
import type { GitChangedFilesDirectoryState } from "../types/appTypes";

describe("useGitChangedFilesController", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("ignores an alias response from an obsolete identity generation", async () => {
    let resolveResponse: ((value: Response) => void) | null = null;
    jest.spyOn(global, "fetch").mockImplementation(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const auxServerBaseUrl = () => "http://runner.test";

    const { result } = await renderHook(() => {
      const [state, setState] = useState<Record<string, GitChangedFilesDirectoryState>>({});
      const stateRef = useRef<Record<string, GitChangedFilesDirectoryState>>({});
      const inFlightRef = useRef(new Map<string, number>());
      const identityGenerationRef = useRef(0);
      const controller = useGitChangedFilesController({
        auxServerBaseUrl,
        runnerToken: "token",
        gitChangedFilesByDirectoryRef: stateRef,
        gitChangedFilesRefreshInFlightRef: inFlightRef,
        directoryIdentityGenerationRef: identityGenerationRef,
        setGitChangedFilesByDirectory: setState,
        logSessionDiag: () => undefined,
      });
      return {
        ...controller,
        state,
        clear: () => {
          stateRef.current = {};
          inFlightRef.current.clear();
          identityGenerationRef.current += 1;
          setState({});
        },
      };
    });

    let refreshPromise: Promise<void> | undefined;
    await act(() => {
      refreshPromise = result.current.refreshGitChangedFiles("/workspace/bitty");
    });
    await act(() => result.current.clear());
    await act(async () => {
      resolveResponse?.({
        ok: true,
        json: async () => ({
          directory: ".",
          stagedFiles: [],
          unstagedFiles: [],
          untrackedFiles: [],
          branches: [],
        }),
      } as Response);
      await refreshPromise;
    });

    expect(result.current.state).toEqual({});
  });
});
