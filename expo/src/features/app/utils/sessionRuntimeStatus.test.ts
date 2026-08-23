import {
  findLatestAssistantMessageIndex,
  hasPendingAssistantReplyInConversation,
  isCommandExecutionMessage,
  settleRunningCommandExecution,
  upsertCommandExecutionMessage,
} from "./sessionRuntimeStatus";
import type { CodexCommandExecutionInfo } from "../../codex/client/types";

const commandExecution: CodexCommandExecutionInfo = {
  command: "npm test",
  status: "completed",
  exitCode: 0,
};

describe("isCommandExecutionMessage", () => {
  it("detects the commandExecution field", () => {
    expect(isCommandExecutionMessage({ commandExecution })).toBe(true);
    expect(isCommandExecutionMessage({})).toBe(false);
    expect(isCommandExecutionMessage(null)).toBe(false);
  });
});

describe("findLatestAssistantMessageIndex", () => {
  it("skips trailing command rows and returns the last text assistant message", () => {
    const messages = [
      { role: "user" },
      { role: "assistant" },
      { role: "assistant", commandExecution },
      { role: "assistant", commandExecution },
    ];
    expect(findLatestAssistantMessageIndex(messages)).toBe(1);
  });

  it("returns -1 when only command rows exist", () => {
    expect(findLatestAssistantMessageIndex([
      { role: "user" },
      { role: "assistant", commandExecution },
    ])).toBe(-1);
  });
});

describe("settleRunningCommandExecution", () => {
  it("settles running commands to completed by default", () => {
    expect(settleRunningCommandExecution(
      { command: "npm test", status: "running" },
      "completed"
    )).toEqual({ command: "npm test", status: "completed" });
  });

  it("settles running commands to failed when the turn errored", () => {
    expect(settleRunningCommandExecution(
      { command: "npm test", status: "running" },
      "error"
    )).toEqual({ command: "npm test", status: "failed" });
  });

  it("leaves non-running commands untouched", () => {
    const failed: CodexCommandExecutionInfo = { command: "false", status: "failed", exitCode: 1 };
    expect(settleRunningCommandExecution(failed, "completed")).toBe(failed);
  });
});

describe("upsertCommandExecutionMessage", () => {
  it("settles a hydrated command when replay only contains the completion", () => {
    const hydrated = [{
      id: "command-1",
      role: "assistant" as const,
      content: "",
      commandExecution: { command: "find . -type f", status: "running" as const, exitCode: null },
    }];

    expect(upsertCommandExecutionMessage(
      hydrated,
      { status: "completed", exitCode: 0 },
      "completed",
      "command-1",
      () => { throw new Error("hydrated row should be updated"); }
    )).toEqual([{
      ...hydrated[0],
      commandExecution: { command: "find . -type f", status: "completed", exitCode: 0 },
    }]);
  });
});

describe("hasPendingAssistantReplyInConversation", () => {
  it("ignores trailing command rows when deciding pending assistant", () => {
    expect(hasPendingAssistantReplyInConversation([
      { role: "user", content: "run tests" },
      { role: "assistant", content: "", commandExecution },
    ])).toBe(true);
  });

  it("stays false when a text assistant reply follows the command row", () => {
    expect(hasPendingAssistantReplyInConversation([
      { role: "user", content: "run tests" },
      { role: "assistant", content: "", commandExecution },
      { role: "assistant", content: "done" },
    ])).toBe(false);
  });
});
