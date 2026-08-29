import { act, renderHook } from "@testing-library/react-native";
import { useSlashCommandController } from "./useSlashCommandController";

test("records only slash commands accepted by a handler", async () => {
  const onCommandAccepted = jest.fn();
  const runSlashStatusCommand = jest.fn(async () => true);
  const { result } = await renderHook(() => useSlashCommandController({
    setTranscript: jest.fn(),
    onCommandAccepted,
    runSlashStatusCommand,
    runSlashCompactCommand: jest.fn(async () => false),
    runSlashCancelQueueCommand: jest.fn(async () => false),
  }));

  await act(async () => {
    await expect(result.current.runSlashCommand(" /status ")).resolves.toBe(true);
    await expect(result.current.runSlashCommand("/compact")).resolves.toBe(false);
    await expect(result.current.runSlashCommand("ordinary message")).resolves.toBe(false);
  });

  expect(onCommandAccepted).toHaveBeenCalledTimes(1);
  expect(onCommandAccepted).toHaveBeenCalledWith("/status");
});
