import { createContext, useContext } from "react";
import { sameVoiceTarget, type VoiceTarget } from "../../appControl/voiceControl";
import type { useBrowserControl } from "../hooks/useBrowserControl";

export const BrowserControlContext = createContext<ReturnType<typeof useBrowserControl> | null>(null);
export function useBrowserControlRequests(target: VoiceTarget | null) {
  const controller = useContext(BrowserControlContext);
  return controller?.requests.filter((request) => target && sameVoiceTarget(request.target, target)) || [];
}
