import { createContext, useContext } from "react";
import { sameVoiceTarget, type VoiceTarget } from "../../appControl/voiceControl";
import type { useBrowserSecretInput } from "../hooks/useBrowserSecretInput";

export const BrowserInputContext = createContext<ReturnType<typeof useBrowserSecretInput> | null>(null);
export function useBrowserInputRequests(target: VoiceTarget | null) {
  const controller = useContext(BrowserInputContext);
  return controller?.requests.filter((request) => target && sameVoiceTarget(request.target, target)) || [];
}
