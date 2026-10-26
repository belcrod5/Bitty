import { getNetworkStateAsync } from "../networkState";
import { resolveTtsAudioQuality } from "./ttsAudioQuality";
import { getNetworkStateAsync as getMacNetworkState } from "../networkState.macos";

jest.mock("../networkState", () => ({ getNetworkStateAsync: jest.fn() }));
const network = jest.mocked(getNetworkStateAsync);
beforeEach(() => network.mockReset());

test("disabled preference preserves standard quality without querying the network", async () => {
  expect(await resolveTtsAudioQuality(false)).toBe("standard");
  expect(network).not.toHaveBeenCalled();
});

test.each(["WIFI", "ETHERNET", "UNKNOWN", "NONE", undefined])("%s keeps standard quality", async (type) => {
  network.mockResolvedValue({ type } as Awaited<ReturnType<typeof getNetworkStateAsync>>);
  expect(await resolveTtsAudioQuality(true)).toBe("standard");
});

test("every request checks the current connection, including a cellular/Wi-Fi handover", async () => {
  network.mockResolvedValueOnce({ type: "CELLULAR" } as Awaited<ReturnType<typeof getNetworkStateAsync>>)
    .mockResolvedValueOnce({ type: "WIFI" } as Awaited<ReturnType<typeof getNetworkStateAsync>>)
    .mockRejectedValueOnce(new Error("network unavailable"));
  expect(await resolveTtsAudioQuality(true)).toBe("lightweight");
  expect(await resolveTtsAudioQuality(true)).toBe("standard");
  expect(await resolveTtsAudioQuality(true)).toBe("standard");
  expect(network).toHaveBeenCalledTimes(3);
});

test("macOS uses the standard fallback without loading a mobile native network module", async () => {
  expect(await getMacNetworkState()).toEqual({ type: "UNKNOWN" });
});
