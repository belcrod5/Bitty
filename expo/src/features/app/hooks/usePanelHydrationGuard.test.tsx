import { act, renderHook } from "@testing-library/react-native";
import { usePanelHydrationGuard } from "./usePanelHydrationGuard";

describe("usePanelHydrationGuard", () => {
  it("supersedes an older hydration for the same panel", async () => {
    const { result } = await renderHook(() => usePanelHydrationGuard());
    let firstIsCurrent = () => false;
    let secondIsCurrent = () => false;

    await act(async () => {
      firstIsCurrent = result.current.beginPanelHydration("popup");
      secondIsCurrent = result.current.beginPanelHydration("popup");
    });

    expect(firstIsCurrent()).toBe(false);
    expect(secondIsCurrent()).toBe(true);
  });

  it("invalidates pending hydration without affecting another panel", async () => {
    const { result } = await renderHook(() => usePanelHydrationGuard());
    let popupIsCurrent = () => false;
    let previewIsCurrent = () => false;

    await act(async () => {
      popupIsCurrent = result.current.beginPanelHydration("popup");
      previewIsCurrent = result.current.beginPanelHydration("preview");
      result.current.invalidatePanelHydration("popup");
    });

    expect(popupIsCurrent()).toBe(false);
    expect(previewIsCurrent()).toBe(true);
  });
});
