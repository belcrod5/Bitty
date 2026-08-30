import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ReplyRequestSessionSnapshot, SttMessageMeta } from "../types/appTypes";
import { parseSlashCommandInput } from "../utils/statusText";

type RunSlashCommandOptions = {
  clearInput?: boolean;
  sttMeta?: SttMessageMeta;
  panelId?: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
};

type UseSlashCommandControllerArgs = {
  setTranscript: Dispatch<SetStateAction<string>>;
  onCommandAccepted: (commandText: string, sessionId?: string) => void;
  runSlashStatusCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<boolean>;
  runSlashCompactCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<boolean>;
  runSlashCancelQueueCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<boolean>;
};

export function useSlashCommandController({
  setTranscript,
  onCommandAccepted,
  runSlashStatusCommand,
  runSlashCompactCommand,
  runSlashCancelQueueCommand,
}: UseSlashCommandControllerArgs) {
  const runSlashCommand = useCallback(async (
    commandTextRaw: string,
    options?: RunSlashCommandOptions
  ) => {
    const parsed = parseSlashCommandInput(commandTextRaw);
    if (!parsed) return false;
    const commandText = parsed.raw;
    let accepted = false;
    if (parsed.name === "/status") {
      accepted = await runSlashStatusCommand(commandText, options);
    } else if (parsed.name === "/compact") {
      accepted = await runSlashCompactCommand(commandText, options);
    } else if (parsed.name === "/cancel-queue" || parsed.name === "/queue-cancel") {
      accepted = await runSlashCancelQueueCommand(commandText, options);
    }
    if (accepted) {
      if (options?.clearInput) setTranscript("");
      const sessionId = options?.sessionSnapshot?.sessionId;
      if (sessionId) onCommandAccepted(commandText, sessionId);
      else onCommandAccepted(commandText);
    }
    return accepted;
  }, [
    onCommandAccepted,
    runSlashCancelQueueCommand,
    runSlashCompactCommand,
    runSlashStatusCommand,
    setTranscript,
  ]);

  return {
    runSlashCommand,
  };
}
