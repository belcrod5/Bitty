import { act, renderHook } from "@testing-library/react-native";
import { Linking } from "react-native";
import { codexItemMessageId } from "../utils/codexItemMessageId";
import { useSessionDeepLinkNavigationController } from "./useSessionDeepLinkNavigationController";

const URL = "bitty://session/claude/session-1?messageId=msg_1&cwd=%2Fwork%2Fproject";

function message(id: string) {
  return { id, role: "assistant" as const, content: "match" };
}

describe("useSessionDeepLinkNavigationController", () => {
  let urlListener: ((event: { url: string }) => void) | null;

  beforeEach(() => {
    urlListener = null;
    jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
    jest.spyOn(Linking, "addEventListener").mockImplementation((_type, listener) => {
      urlListener = listener as (event: { url: string }) => void;
      return { remove: jest.fn() } as unknown as ReturnType<typeof Linking.addEventListener>;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  async function renderController(overrides: {
    settingsLoaded?: boolean;
    openSession?: jest.Mock;
    loadOlder?: jest.Mock;
    getMessages?: jest.Mock;
  } = {}) {
    const openSession = overrides.openSession || jest.fn().mockResolvedValue(true);
    const closeDrawer = jest.fn();
    const loadOlder = overrides.loadOlder || jest.fn().mockResolvedValue({ loaded: false, hasMore: false });
    const getMessages = overrides.getMessages || jest.fn().mockReturnValue([
      message(codexItemMessageId("session-1", "msg_1")),
    ]);
    const setJumpTarget = jest.fn();
    const onNotFound = jest.fn();
    const rendered = await renderHook(() => useSessionDeepLinkNavigationController({
      settingsLoaded: overrides.settingsLoaded ?? true,
      openSession,
      closeDrawer,
      loadOlder,
      getMessages,
      setJumpTarget,
      onNotFound,
    }));
    return { ...rendered, openSession, closeDrawer, loadOlder, getMessages, setJumpTarget, onNotFound };
  }

  it("opens an admitted session and jumps to an already loaded message", async () => {
    const controller = await renderController();
    await act(async () => urlListener?.({ url: URL }));
    expect(controller.openSession).toHaveBeenCalledWith({
      backendId: "claude",
      sessionId: "session-1",
      directory: "/work/project",
      source: "all",
      origin: "drawer",
    });
    expect(controller.loadOlder).not.toHaveBeenCalled();
    expect(controller.setJumpTarget).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      messageId: codexItemMessageId("session-1", "msg_1"),
    }));
  });

  it("uses bounded existing paging until the target message is loaded", async () => {
    let calls = 0;
    const getMessages = jest.fn(() => calls >= 2
      ? [message(codexItemMessageId("session-1", "msg_1"))]
      : []);
    const loadOlder = jest.fn(async () => {
      calls += 1;
      return { loaded: true, hasMore: true };
    });
    const controller = await renderController({ getMessages, loadOlder });
    await act(async () => urlListener?.({ url: URL }));
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(controller.setJumpTarget).toHaveBeenCalledTimes(1);
  });

  it("does not open malformed external input", async () => {
    const controller = await renderController();
    await act(async () => urlListener?.({ url: "bitty://session/claude/session-1?messageId=../bad&cwd=/work" }));
    expect(controller.openSession).not.toHaveBeenCalled();
  });

  it("does not retry a session rejected by existing admission", async () => {
    const openSession = jest.fn().mockResolvedValue(false);
    const controller = await renderController({ openSession });
    await act(async () => urlListener?.({ url: URL }));
    expect(controller.openSession).toHaveBeenCalledTimes(1);
  });
});
