import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { CalendarWriteConfirmation } from "../../calendar/calendarToolHandler";
import { useCalendarWriteRequestController } from "./useCalendarWriteRequestController";

const originalAppState = AppState.currentState;

function write(signal: AbortSignal, title = "Planning") {
  return {
    operation: "calendar_create_event",
    signal,
    view: {
      title,
      start: "2026-07-26T09:00:00+09:00",
      end: "2026-07-26T10:00:00+09:00",
      allDay: false,
      timeZone: "Asia/Tokyo",
      location: "",
      notes: "",
      calendarId: "calendar-1",
      lastModifiedAt: "",
      recurring: false,
      allowsModifications: true,
    },
  } satisfies CalendarWriteConfirmation;
}

describe("useCalendarWriteRequestController", () => {
  const appStateListeners = new Set<(state: string) => void>();
  let addEventListener: jest.SpyInstance;

  beforeEach(() => {
    AppState.currentState = "active";
    addEventListener = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
      appStateListeners.add(listener as (state: string) => void);
      return { remove: () => appStateListeners.delete(listener as (state: string) => void) } as never;
    });
  });

  afterEach(() => {
    AppState.currentState = originalAppState;
    appStateListeners.clear();
    addEventListener.mockRestore();
  });

  it("cancels a duplicate request, removes its abort listener, and accepts only the active request", async () => {
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const removeFirstAbortListener = jest.spyOn(firstAbort.signal, "removeEventListener");
    const { result } = await renderHook(() => useCalendarWriteRequestController());

    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.confirmWrite(write(firstAbort.signal, "First"));
    });
    expect(result.current.request?.view.title).toBe("First");

    let second!: Promise<boolean>;
    await act(async () => {
      second = result.current.confirmWrite(write(secondAbort.signal, "Second"));
    });
    await expect(first).resolves.toBe(false);
    expect(removeFirstAbortListener).toHaveBeenCalled();
    expect(result.current.request?.view.title).toBe("Second");

    await act(async () => {
      result.current.decide(true);
    });
    await expect(second).resolves.toBe(true);
    expect(result.current.request).toBeNull();
  });

  it("cancels a pending request on backgrounding or abort, and never approves while backgrounded", async () => {
    const { result } = await renderHook(() => useCalendarWriteRequestController());
    const backgroundAbort = new AbortController();
    let backgroundRequest!: Promise<boolean>;
    await act(async () => {
      backgroundRequest = result.current.confirmWrite(write(backgroundAbort.signal));
      for (const listener of appStateListeners) listener("background");
    });
    await expect(backgroundRequest).resolves.toBe(false);
    expect(result.current.request).toBeNull();

    AppState.currentState = "active";
    const abort = new AbortController();
    let abortRequest!: Promise<boolean>;
    await act(async () => {
      abortRequest = result.current.confirmWrite(write(abort.signal));
      abort.abort();
    });
    await expect(abortRequest).resolves.toBe(false);

    const decideAbort = new AbortController();
    let decideRequest!: Promise<boolean>;
    await act(async () => {
      decideRequest = result.current.confirmWrite(write(decideAbort.signal));
      AppState.currentState = "background";
      result.current.decide(true);
    });
    await expect(decideRequest).resolves.toBe(false);
  });

  it("removes the AppState listener on unmount", async () => {
    const { unmount } = await renderHook(() => useCalendarWriteRequestController());
    expect(appStateListeners.size).toBe(1);

    await act(async () => {
      unmount();
    });
    expect(appStateListeners.size).toBe(0);
  });
});
