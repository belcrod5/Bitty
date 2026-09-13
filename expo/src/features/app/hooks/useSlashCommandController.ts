import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  ComposerInputDisposition,
  ReplyRequestSessionSnapshot,
  SttMessageMeta,
} from "../types/appTypes";
import { parseSlashCommandInput } from "../utils/statusText";

type RunSlashCommandOptions = {
  clearInput?: boolean;
  inputDisposition?: ComposerInputDisposition;
  onAccepted?: () => void;
  sttMeta?: SttMessageMeta;
  panelId?: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
};

type UseSlashCommandControllerArgs = {
  setTranscript: Dispatch<SetStateAction<string>>;
  onCommandAccepted: (
    commandText: string,
    sessionId: string | undefined,
    inputDisposition: ComposerInputDisposition
  ) => void;
  runSlashStatusCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<void>;
  runSlashCompactCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<void>;
  runSlashCancelQueueCommand: (commandText: string, options?: RunSlashCommandOptions) => Promise<void>;
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
    const inputDisposition = options?.inputDisposition || parsed.inputDisposition;
    let runCommand: UseSlashCommandControllerArgs["runSlashStatusCommand"];
    if (parsed.name === "/status") {
      runCommand = runSlashStatusCommand;
    } else if (parsed.name === "/compact") {
      runCommand = runSlashCompactCommand;
    } else if (parsed.name === "/cancel-queue" || parsed.name === "/queue-cancel") {
      runCommand = runSlashCancelQueueCommand;
    } else {
      return false;
    }
    if (options?.clearInput && inputDisposition === "clear") setTranscript("");
    const sessionId = options?.sessionSnapshot?.sessionId;
    onCommandAccepted(commandText, sessionId, inputDisposition);
    if (inputDisposition === "clear") options?.onAccepted?.();
    await runCommand(commandText, options);
    return true;
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
