import { act, renderHook } from "@testing-library/react-native";
import { usePendingVoiceNavigationController } from "./usePendingVoiceNavigationController";
import {
  clearPendingVoiceOrchestratorId,
  getPendingVoiceOrchestratorId,
  setPendingVoiceOrchestratorId,
} from "../utils/pendingVoiceNavigation";

afterEach(() => clearPendingVoiceOrchestratorId(getPendingVoiceOrchestratorId()));

async function renderController(popupMounted: boolean) {
  const requestPopupClose = jest.fn();
  const closeDrawer = jest.fn();
  const setActiveScreen = jest.fn();
  const rendered = await renderHook<string, { mounted: boolean }>(({ mounted }) => usePendingVoiceNavigationController({
    popupMounted: mounted,
    requestPopupClose,
    closeDrawer,
    setActiveScreen,
  }), { initialProps: { mounted: popupMounted } });
  return { ...rendered, requestPopupClose, closeDrawer, setActiveScreen };
}

test("waits for popup cleanup before routing from another screen or delivering a voice target", async () => {
  const { result, rerender, requestPopupClose, closeDrawer, setActiveScreen } = await renderController(true);
  await act(async () => setPendingVoiceOrchestratorId("siri-target"));
  expect(closeDrawer).toHaveBeenCalledTimes(1);
  expect(requestPopupClose).toHaveBeenCalledTimes(1);
  expect(setActiveScreen).not.toHaveBeenCalled();
  expect(result.current).toBe("");
  expect(getPendingVoiceOrchestratorId()).toBe("siri-target");

  // visible=false only starts the existing animation; panel removal completes it.
  await rerender({ mounted: true });
  expect(result.current).toBe("");
  expect(setActiveScreen).not.toHaveBeenCalled();
  await rerender({ mounted: false });
  expect(setActiveScreen).toHaveBeenCalledWith("skia_board");
  expect(result.current).toBe("siri-target");
});

test("delivers the latest shared intent after closing and observes its acknowledgement", async () => {
  const { result, rerender } = await renderController(true);
  await act(async () => setPendingVoiceOrchestratorId("siri-target"));
  await act(async () => setPendingVoiceOrchestratorId("push-target"));
  expect(result.current).toBe("");
  await rerender({ mounted: false });
  expect(result.current).toBe("push-target");
  await act(async () => clearPendingVoiceOrchestratorId("siri-target"));
  expect(result.current).toBe("push-target");
  await act(async () => clearPendingVoiceOrchestratorId("push-target"));
  expect(result.current).toBe("");
  await act(async () => setPendingVoiceOrchestratorId("push-target"));
  expect(result.current).toBe("push-target");
});

test("retains a cold-start intent and immediately routes when no popup exists", async () => {
  setPendingVoiceOrchestratorId("cold-start");
  const { result, requestPopupClose, closeDrawer, setActiveScreen } = await renderController(false);
  expect(result.current).toBe("cold-start");
  expect(closeDrawer).toHaveBeenCalled();
  expect(requestPopupClose).not.toHaveBeenCalled();
  expect(setActiveScreen).toHaveBeenCalledWith("skia_board");
});
