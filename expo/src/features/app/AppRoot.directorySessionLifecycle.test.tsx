import { readFileSync } from "node:fs";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { act, renderHook } from "@testing-library/react-native";
import ts from "typescript";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";
import { useSessionStartupRecoveryController } from "./hooks/useSessionStartupRecoveryController";

// Exercise AppRoot's actual inline effect without loading the app's native UI graph.
const source = readFileSync(`${__dirname}/AppRoot.tsx`, "utf8");
const ast = ts.createSourceFile("AppRoot.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let directoryRefDeclaration = "";
let directoryEffect = "";
function locateDirectoryLifecycle(node: ts.Node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(
    (declaration) => declaration.name.getText(ast) === "llmSessionDirectoryRef",
  )) directoryRefDeclaration = node.getText(ast);
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === "useEffect"
    && node.getText(ast).includes("startNewSession({ directory: normalizedDirectory })")) {
    directoryEffect = node.getText(ast);
  }
  ts.forEachChild(node, locateDirectoryLifecycle);
}
locateDirectoryLifecycle(ast);
if (!directoryRefDeclaration || !directoryEffect) throw new Error("AppRoot directory lifecycle was not found");

type DirectoryEffectArgs = {
  settingsLoaded: boolean;
  llmDirectory: string;
  normalizedLlmDirectoryForRequest: () => string;
  llmSessionRestoreInFlightRef: MutableRefObject<boolean>;
  llmSessionRestoreLoadingRef: MutableRefObject<boolean>;
  setReplyDebug: (update: (previous: string) => string) => void;
  startNewSession: (params: { directory: string }) => void;
};
const useAppRootDirectoryLifecycle = new Function("useEffect", "useRef", ts.transpile(`
  function useAppRootDirectoryLifecycle(args) {
    const { settingsLoaded, llmDirectory, normalizedLlmDirectoryForRequest,
      llmSessionRestoreInFlightRef, llmSessionRestoreLoadingRef, setReplyDebug, startNewSession } = args;
    const DEFAULT_LLM_DIRECTORY = "llm_root";
    ${directoryRefDeclaration}
    ${directoryEffect}
    return llmSessionDirectoryRef;
  }
`) + "\nreturn useAppRootDirectoryLifecycle;")(useEffect, useRef) as (
  args: DirectoryEffectArgs,
) => MutableRefObject<string>;

class FakeRunnerWebSocketManager {
  private listeners = new Set<() => void>();
  private snapshot = { connectionState: "connecting" };
  subscribeSnapshot = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  ready() {
    this.snapshot = { connectionState: "ready" };
    this.listeners.forEach((listener) => listener());
  }
}

async function mountDirectoryLifecycle() {
  const manager = new FakeRunnerWebSocketManager();
  const startNewSession = jest.fn();
  const selectSpecificLlmSession = jest.fn(async (sessionId: unknown) => sessionId === "saved-session");
  const fetchLatestSessionForDirectory = jest.fn(async () => ({ sessionId: "saved-session", backendId: "codex" }));
  const hook = await renderHook(() => {
    const [state, setState] = useState({ settingsLoaded: false, directory: "llm_root", selectedSessionId: "" });
    const inFlight = useRef(false);
    const loading = useRef(false);
    const attempted = useRef(false);
    const messages = useRef([]);
    const directoryRef = useAppRootDirectoryLifecycle({
      settingsLoaded: state.settingsLoaded,
      llmDirectory: state.directory,
      normalizedLlmDirectoryForRequest: () => state.directory,
      llmSessionRestoreInFlightRef: inFlight,
      llmSessionRestoreLoadingRef: loading,
      setReplyDebug: jest.fn(),
      startNewSession: (params) => {
        startNewSession(params);
        setState((current) => ({ ...current, selectedSessionId: "unsaved-local-session" }));
      },
    });
    useSessionStartupRecoveryController({
      settingsLoaded: state.settingsLoaded,
      runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
      startupSessionRestoreAttemptedRef: attempted,
      conversationMessagesRef: messages,
      codexWsUrl: "ws://runner.test/runner-ws",
      normalizedLlmDirectoryForRequest: () => state.directory,
      parseOptionalSessionId: (value) => String(value || ""),
      selectedLlmSessionId: state.selectedSessionId,
      getLlmConversationSessionId: () => state.selectedSessionId,
      selectSpecificLlmSession,
      fetchLatestSessionForDirectory,
      setLlmSessionRestoreError: jest.fn(),
    });
    return { state, setState, inFlight, loading, directoryRef };
  });
  return { ...hook, manager, startNewSession, selectSpecificLlmSession, fetchLatestSessionForDirectory };
}

describe("AppRoot directory/session startup lifecycle", () => {
  it.each(["batched", "staged"])("preserves the saved session during %s settings hydration", async (mode) => {
    const hook = await mountDirectoryLifecycle();
    await act(async () => {
      hook.result.current.setState({
        settingsLoaded: mode === "batched",
        directory: "/saved/workspace",
        selectedSessionId: "saved-session",
      });
    });
    if (mode === "staged") {
      await act(async () => {
        hook.result.current.setState((current) => ({ ...current, settingsLoaded: true }));
      });
    }
    await act(async () => { hook.manager.ready(); });
    expect(hook.startNewSession).not.toHaveBeenCalled();
    expect(hook.result.current.state.selectedSessionId).toBe("saved-session");
    expect(hook.selectSpecificLlmSession).toHaveBeenCalledTimes(1);
    expect(hook.selectSpecificLlmSession).toHaveBeenCalledWith("saved-session", {
      source: "all", directory: "/saved/workspace",
    });
    expect(hook.fetchLatestSessionForDirectory).not.toHaveBeenCalled();
  });

  it("still starts a new session for a later folder change or settings import", async () => {
    const hook = await mountDirectoryLifecycle();
    await act(async () => {
      hook.result.current.setState({ settingsLoaded: true, directory: "/saved", selectedSessionId: "saved-session" });
    });
    await act(async () => {
      hook.result.current.setState((current) => ({ ...current, directory: "/user-chosen" }));
    });
    expect(hook.startNewSession).toHaveBeenCalledTimes(1);
    expect(hook.startNewSession).toHaveBeenLastCalledWith({ directory: "/user-chosen" });
    await act(async () => {
      hook.result.current.setState({ settingsLoaded: true, directory: "/imported", selectedSessionId: "imported-session" });
    });
    expect(hook.startNewSession).toHaveBeenCalledTimes(2);
    expect(hook.startNewSession).toHaveBeenLastCalledWith({ directory: "/imported" });
  });

  it("keeps an explicitly started new chat in the same directory", async () => {
    const hook = await mountDirectoryLifecycle();
    await act(async () => {
      hook.result.current.setState({ settingsLoaded: true, directory: "/saved", selectedSessionId: "saved-session" });
    });
    await act(async () => {
      hook.result.current.setState((current) => ({ ...current, selectedSessionId: "new-local-chat" }));
    });
    expect(hook.startNewSession).not.toHaveBeenCalled();
    expect(hook.result.current.state.selectedSessionId).toBe("new-local-chat");
  });

  it.each(["inFlight", "loading"] as const)("preserves the existing restore guard (%s)", async (guard) => {
    const hook = await mountDirectoryLifecycle();
    await act(async () => {
      hook.result.current.setState({ settingsLoaded: true, directory: "/saved", selectedSessionId: "saved-session" });
    });
    await act(async () => {
      hook.result.current[guard].current = true;
      hook.result.current.setState((current) => ({ ...current, directory: "/restoring" }));
    });
    expect(hook.startNewSession).not.toHaveBeenCalled();
    expect(hook.result.current.directoryRef.current).toBe("/restoring");
    await act(async () => {
      hook.result.current[guard].current = false;
      hook.result.current.setState((current) => ({ ...current, directory: "/next-folder" }));
    });
    expect(hook.startNewSession).toHaveBeenCalledTimes(1);
  });

  it("preserves an adopted or canonicalized directory without resetting the session", async () => {
    const hook = await mountDirectoryLifecycle();
    await act(async () => {
      hook.result.current.setState({ settingsLoaded: true, directory: "/saved", selectedSessionId: "saved-session" });
    });
    await act(async () => {
      // Both history adoption and directory identity reconciliation update this ref before state.
      hook.result.current.directoryRef.current = "/canonical";
      hook.result.current.setState((current) => ({ ...current, directory: "/canonical" }));
    });
    expect(hook.startNewSession).not.toHaveBeenCalled();
    expect(hook.result.current.state.selectedSessionId).toBe("saved-session");
  });
});
