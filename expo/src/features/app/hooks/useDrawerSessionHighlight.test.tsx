import { act, renderHook } from "@testing-library/react-native";
import { useDrawerSessionHighlight } from "./useDrawerSessionHighlight";

function renderHighlightHook(initialSelectedLlmSessionId: string) {
  return renderHook(
    (selectedLlmSessionId: string) => useDrawerSessionHighlight(selectedLlmSessionId),
    { initialProps: initialSelectedLlmSessionId }
  );
}

describe("useDrawerSessionHighlight", () => {
  it("falls back to the main chat selected session", async () => {
    const { result } = await renderHighlightHook("main-session");

    expect(result.current.drawerHighlightedSessionId).toBe("main-session");
  });

  it("highlights the session opened in the drawer popup over the main selection", async () => {
    const { result } = await renderHighlightHook("main-session");

    await act(async () => {
      result.current.setDrawerPopupHighlightSessionId("popup-session");
    });

    expect(result.current.drawerHighlightedSessionId).toBe("popup-session");
  });

  it("returns to the main selection when the popup override is cleared", async () => {
    const { result } = await renderHighlightHook("main-session");

    await act(async () => {
      result.current.setDrawerPopupHighlightSessionId("popup-session");
    });
    await act(async () => {
      result.current.setDrawerPopupHighlightSessionId("");
    });

    expect(result.current.drawerHighlightedSessionId).toBe("main-session");
  });

  it("resets the popup override when the main chat selection changes", async () => {
    const { result, rerender } = await renderHighlightHook("main-session");

    await act(async () => {
      result.current.setDrawerPopupHighlightSessionId("popup-session");
    });
    await rerender("next-main-session");

    expect(result.current.drawerHighlightedSessionId).toBe("next-main-session");
  });
});
