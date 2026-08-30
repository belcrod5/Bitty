import { act, renderHook, waitFor } from "@testing-library/react-native";
import { mutatePersistedSettings, readPersistedSettingsField } from "../utils/persistedSettingsFile";
import {
  normalizeSkiaBoardViewport,
  useSkiaBoardViewportPersistence,
} from "./useSkiaBoardViewportPersistence";

jest.mock("../utils/persistedSettingsFile", () => ({
  SKIA_BOARD_VIEWPORT_FIELD: "skiaBoardViewport",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

const mockRead = jest.mocked(readPersistedSettingsField);
const mockMutate = jest.mocked(mutatePersistedSettings);

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue(undefined);
  mockMutate.mockImplementation(async (mutate) => { mutate({}); });
});

test("validates and clamps persisted viewport values at the storage boundary", () => {
  expect(normalizeSkiaBoardViewport({ x: Infinity, y: 2, scale: 1 })).toBeNull();
  expect(normalizeSkiaBoardViewport({ x: "1", y: 2, scale: 1 })).toBeNull();
  expect(normalizeSkiaBoardViewport({ x: 2_000_000, y: -2_000_000, scale: 99 })).toEqual({
    x: 1_000_000,
    y: -1_000_000,
    scale: 2.5,
  });
});

test("restores once and persists normalized final values without duplicate writes", async () => {
  mockRead.mockResolvedValue({ x: 120, y: -40, scale: 1.5 });
  const values = { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 } };
  const { result } = await renderHook(() => useSkiaBoardViewportPersistence(values as never));
  await waitFor(() => expect(values).toEqual({
    x: { value: 120 }, y: { value: -40 }, scale: { value: 1.5 },
  }));

  await act(async () => {
    result.current.persistViewport(120, -40, 1.5);
    result.current.persistViewport(150, -60, 4);
  });
  await act(async () => Promise.resolve());
  expect(mockMutate).toHaveBeenCalledTimes(1);
  const mutation = mockMutate.mock.calls[0][0];
  expect(mutation({ keep: true })).toEqual({
    keep: true,
    skiaBoardViewport: { x: 150, y: -60, scale: 2.5 },
  });
});
