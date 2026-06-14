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
  runSlashStatusCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<boolean>;
  runSlashCompactCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<boolean>;
  runSlashCancelQueueCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<boolean>;
};

export function useSlashCommandController({
  setTranscript,
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
    if (options?.clearInput) {
      setTranscript("");
    }
    if (parsed.name === "/status") {
      return runSlashStatusCommand(commandText, options);
    }
    if (parsed.name === "/compact") {
      return runSlashCompactCommand(commandText, options);
    }
    if (parsed.name === "/cancel-queue" || parsed.name === "/queue-cancel") {
      return runSlashCancelQueueCommand(commandText, options);
    }
    return false;
  }, [
    runSlashCancelQueueCommand,
    runSlashCompactCommand,
    runSlashStatusCommand,
    setTranscript,
  ]);

  return {
    runSlashCommand,
  };
}
