import { act, renderHook, waitFor } from "@testing-library/react-native";
import {
  COMPOSER_MESSAGE_HISTORY_FIELD,
  mutatePersistedSettings,
  readPersistedSettingsField,
} from "../utils/persistedSettingsFile";
import {
  COMPOSER_MESSAGE_HISTORY_LIMIT,
  parseComposerMessageHistory,
  useComposerMessageHistory,
} from "./useComposerMessageHistory";

jest.mock("../utils/persistedSettingsFile", () => ({
  COMPOSER_MESSAGE_HISTORY_FIELD: "composerMessageHistory",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

const mockRead = jest.mocked(readPersistedSettingsField);
const mockMutate = jest.mocked(mutatePersistedSettings);

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue([]);
  mockMutate.mockImplementation(async (mutate) => {
    mutate({});
  });
});

test("normalizes persisted history without deduplicating repeated sends", () => {
  expect(parseComposerMessageHistory([" same ", "same", "", 123])).toEqual(["same", "same"]);
});

test("loads history and keeps only the latest 20 accepted messages", async () => {
  mockRead.mockResolvedValue(["previous"]);
  const { result } = await renderHook(() => useComposerMessageHistory());

  await waitFor(() => expect(result.current.messages).toEqual(["previous"]));
  await act(async () => {
    for (let index = 1; index <= 21; index += 1) {
      result.current.recordMessage(`message ${index}`);
    }
    await Promise.resolve();
  });

  expect(result.current.messages).toHaveLength(COMPOSER_MESSAGE_HISTORY_LIMIT);
  expect(result.current.messages[0]).toBe("message 21");
  expect(result.current.messages.at(-1)).toBe("message 2");
  expect(mockMutate).toHaveBeenCalledTimes(21);
  const lastMutation = mockMutate.mock.calls.at(-1)?.[0];
  expect(lastMutation?.({ [COMPOSER_MESSAGE_HISTORY_FIELD]: ["same", "same"] }))
    .toEqual({ [COMPOSER_MESSAGE_HISTORY_FIELD]: ["message 21", "same", "same"] });
});

test("does not record empty input", async () => {
  const { result } = await renderHook(() => useComposerMessageHistory());
  await act(async () => result.current.recordMessage("  \n "));
  expect(mockMutate).not.toHaveBeenCalled();
});
