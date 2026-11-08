import { useCallback, useEffect, useRef, useState } from "react";

export type ComputerInfo = {
  hostname: string;
  operatingSystem: string;
  architecture: string;
  totalMemory: number;
  homePath: string;
};

export type ComputerFileEntry = {
  kind: "dir" | "file";
  name: string;
  path: string;
  modifiedAt: string | null;
};

type DirectoryListing = {
  basePath: string;
  parentPath: string;
  entries: ComputerFileEntry[];
  truncated: boolean;
};

type BrowserState = {
  connection: string;
  computer: ComputerInfo | null;
  directory: DirectoryListing | null;
  loading: boolean;
  error: string;
};

export function useComputerBrowser(runnerUrl: string, runnerToken: string) {
  const baseUrl = runnerUrl.trim().replace(/\/+$/, "");
  const token = runnerToken.trim();
  const connection = JSON.stringify([baseUrl, token]);
  const emptyState: BrowserState = { connection, computer: null, directory: null, loading: true, error: "" };
  const [state, setState] = useState<BrowserState>(emptyState);
  const requestRef = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 });
  const computerRef = useRef<{ connection: string; value: ComputerInfo } | null>(null);

  const browse = useCallback(async (path?: string) => {
    requestRef.current.controller?.abort();
    const sequence = ++requestRef.current.sequence;
    const controller = new AbortController();
    requestRef.current.controller = controller;
    setState((previous) => ({
      connection,
      computer: previous.connection === connection ? previous.computer : null,
      directory: previous.connection === connection ? previous.directory : null,
      loading: true,
      error: "",
    }));
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    const read = async (resource: string) => {
      const response = await fetch(`${baseUrl}${resource}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(String(data.message || data.error || `HTTP ${response.status}`));
      return data;
    };
    try {
      if (!baseUrl || !token) throw new Error("設定でコンピューターへの接続を確認してください。");
      let computer = computerRef.current?.connection === connection ? computerRef.current.value : null;
      if (!computer) {
        computer = await read("/computer") as ComputerInfo;
        if (sequence !== requestRef.current.sequence) return;
        computerRef.current = { connection, value: computer };
        setState((previous) => ({ ...previous, computer }));
      }
      const params = new URLSearchParams({ path: path ?? computer.homePath, view: "computer" });
      const directory = await read(`/directories?${params}`) as DirectoryListing;
      if (sequence !== requestRef.current.sequence) return;
      setState({ connection, computer, directory, loading: false, error: "" });
    } catch (error) {
      if (sequence !== requestRef.current.sequence) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: timedOut ? "接続がタイムアウトしました。もう一度お試しください。"
          : error instanceof Error ? error.message : String(error),
      }));
    } finally {
      clearTimeout(timeout);
    }
  }, [baseUrl, token, connection]);

  useEffect(() => {
    void browse();
    return () => {
      ++requestRef.current.sequence;
      requestRef.current.controller?.abort();
    };
  }, [browse]);

  return { ...(state.connection === connection ? state : emptyState), browse };
}
