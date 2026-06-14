import { useCallback } from "react";
import type { UiSfxKey } from "../types/appTypes";

type UseAssistantEventSfxControllerOptions = {
  playUiSfx: (key: UiSfxKey, options?: { minIntervalMs?: number }) => void;
};

export function useAssistantEventSfxController(options: UseAssistantEventSfxControllerOptions) {
  const { playUiSfx } = options;

  const playAssistantEventSfx = useCallback((rawContent: string) => {
    const content = String(rawContent || "").trim();
    if (!content) return;
    if (content.startsWith("tool_approval_required")) {
      playUiSfx("approval");
      return;
    }
    if (content.startsWith("tool_approval_denied")) {
      playUiSfx("error");
      return;
    }
    if (content.startsWith("tool_approval_granted") || content.startsWith("tool_approval_auto")) {
      playUiSfx("toolDone");
      return;
    }
    if (content.startsWith("tool_error :")) {
      playUiSfx("error");
      return;
    }
    if (content.startsWith("tool:")) {
      playUiSfx("toolDone");
      return;
    }
    if (content.startsWith("tool :") || content.startsWith("file_open :")) {
      playUiSfx("toolStart");
      return;
    }
    if (content.startsWith("media :")) {
      playUiSfx("toolDone");
    }
  }, [playUiSfx]);

  return {
    playAssistantEventSfx,
  };
}
