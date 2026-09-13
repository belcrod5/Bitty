import { renderHook } from "@testing-library/react-native";
import { useSlashCommandController } from "./useSlashCommandController";

test("preserves compact input before and after its async work completes", async () => {
  let completeCompact = () => {};
  const compactCompletion = new Promise<void>((resolve) => {
    completeCompact = resolve;
  });
  const onCommandAccepted = jest.fn();
  const onAccepted = jest.fn();
  const runSlashCompactCommand = jest.fn(() => compactCompletion);
  let transcript = "/compact";
  const setTranscript = jest.fn((next: string | ((previous: string) => string)) => {
    transcript = typeof next === "function" ? next(transcript) : next;
  });
  const { result } = await renderHook(() => useSlashCommandController({
    setTranscript,
    onCommandAccepted,
    runSlashStatusCommand: jest.fn(async () => {}),
    runSlashCompactCommand,
    runSlashCancelQueueCommand: jest.fn(async () => {}),
  }));

  const commandCompletion = result.current.runSlashCommand("/compact", {
    clearInput: true,
    onAccepted,
    sessionSnapshot: { sessionId: "session-1" },
  });

  expect(transcript).toBe("/compact");
  expect(setTranscript).not.toHaveBeenCalled();
  expect(onCommandAccepted).toHaveBeenCalledWith("/compact", "session-1", "preserve");
  expect(onAccepted).not.toHaveBeenCalled();
  expect(runSlashCompactCommand).toHaveBeenCalledTimes(1);

  transcript = "next message";
  completeCompact();
  await expect(commandCompletion).resolves.toBe(true);

  expect(transcript).toBe("next message");
  expect(setTranscript).not.toHaveBeenCalled();
  expect(onAccepted).not.toHaveBeenCalled();
});

test("clears other accepted commands before async work completes without clearing later input", async () => {
  let completeStatus = () => {};
  const statusCompletion = new Promise<void>((resolve) => {
    completeStatus = resolve;
  });
  const onCommandAccepted = jest.fn();
  const onAccepted = jest.fn();
  let transcript = "/status";
  const setTranscript = jest.fn((next: string | ((previous: string) => string)) => {
    transcript = typeof next === "function" ? next(transcript) : next;
  });
  const { result } = await renderHook(() => useSlashCommandController({
    setTranscript,
    onCommandAccepted,
    runSlashStatusCommand: jest.fn(() => statusCompletion),
    runSlashCompactCommand: jest.fn(async () => {}),
    runSlashCancelQueueCommand: jest.fn(async () => {}),
  }));

  const commandCompletion = result.current.runSlashCommand("/status", { clearInput: true, onAccepted });

  expect(transcript).toBe("");
  expect(onCommandAccepted).toHaveBeenCalledWith("/status", undefined, "clear");
  expect(onAccepted).toHaveBeenCalledTimes(1);

  transcript = "next message";
  completeStatus();
  await expect(commandCompletion).resolves.toBe(true);
  expect(transcript).toBe("next message");
});

test("keeps input when the slash command is not supported", async () => {
  const onCommandAccepted = jest.fn();
  const onAccepted = jest.fn();
  const setTranscript = jest.fn();
  const runSlashStatusCommand = jest.fn(async () => {});
  const runSlashCompactCommand = jest.fn(async () => {});
  const runSlashCancelQueueCommand = jest.fn(async () => {});
  const { result } = await renderHook(() => useSlashCommandController({
    setTranscript,
    onCommandAccepted,
    runSlashStatusCommand,
    runSlashCompactCommand,
    runSlashCancelQueueCommand,
  }));

  await expect(result.current.runSlashCommand("/unknown", { clearInput: true, onAccepted })).resolves.toBe(false);
  await expect(result.current.runSlashCommand("ordinary message", { clearInput: true, onAccepted })).resolves.toBe(false);

  expect(setTranscript).not.toHaveBeenCalled();
  expect(onCommandAccepted).not.toHaveBeenCalled();
  expect(onAccepted).not.toHaveBeenCalled();
  expect(runSlashStatusCommand).not.toHaveBeenCalled();
  expect(runSlashCompactCommand).not.toHaveBeenCalled();
  expect(runSlashCancelQueueCommand).not.toHaveBeenCalled();
});
