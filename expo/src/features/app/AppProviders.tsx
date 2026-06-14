import type { ReactNode } from "react";
import {
  AppShellProvider,
  type AppShellContextValue,
} from "./contexts/AppShellContext";
import {
  AppSettingsProvider,
  type AppSettingsContextValue,
} from "./contexts/AppSettingsContext";
import {
  ConversationProvider,
  type ConversationContextValue,
} from "./contexts/ConversationContext";
import {
  PanelRuntimeStoreProvider,
  type PanelRuntimeStoreContextValue,
} from "./contexts/PanelRuntimeStoreContext";
import {
  PanelRuntimeControllerProvider,
  type PanelRuntimeControllerContextValue,
} from "./contexts/PanelRuntimeControllerContext";
import {
  AudioLabProvider,
  type AudioLabContextValue,
} from "./contexts/AudioLabContext";
import {
  YouTubePlayerProvider,
  type YouTubePlayerContextValue,
} from "./contexts/YouTubePlayerContext";
import {
  ChatDiagnosticsProvider,
  type ChatDiagnosticsContextValue,
} from "./contexts/ChatDiagnosticsContext";
import {
  ChatComposerProvider,
  type ChatComposerContextValue,
} from "./contexts/ChatComposerContext";
import {
  ChatVisualProvider,
  type ChatVisualContextValue,
} from "./contexts/ChatVisualContext";
import {
  ChatScreenProvider,
  type ChatScreenContextValue,
} from "./contexts/ChatScreenContext";
import {
  DebugRuntimeProvider,
  type DebugRuntimeContextValue,
} from "./contexts/DebugRuntimeContext";
import {
  DebugConversationProvider,
  type DebugConversationContextValue,
} from "./contexts/DebugConversationContext";
import {
  DebugSpeechProvider,
  type DebugSpeechContextValue,
} from "./contexts/DebugSpeechContext";
import { RunnerWsProvider } from "../runnerWs/RunnerWsProvider";

type AppProvidersProps = {
  appShell: AppShellContextValue;
  appSettings: AppSettingsContextValue;
  conversation: ConversationContextValue;
  panelRuntimeStore: PanelRuntimeStoreContextValue;
  panelRuntimeController: PanelRuntimeControllerContextValue;
  audioLab: AudioLabContextValue;
  youTubePlayer: YouTubePlayerContextValue;
  chatDiagnostics: ChatDiagnosticsContextValue;
  chatComposer: ChatComposerContextValue;
  chatVisual: ChatVisualContextValue;
  chatScreen: ChatScreenContextValue;
  debugRuntime: DebugRuntimeContextValue;
  debugConversation: DebugConversationContextValue;
  debugSpeech: DebugSpeechContextValue;
  runnerWsUrl: string;
  runnerWsToken: string;
  runnerWsEnabled: boolean;
  children: ReactNode;
};

export function AppProviders({
  appShell,
  appSettings,
  conversation,
  panelRuntimeStore,
  panelRuntimeController,
  audioLab,
  youTubePlayer,
  chatDiagnostics,
  chatComposer,
  chatVisual,
  chatScreen,
  debugRuntime,
  debugConversation,
  debugSpeech,
  runnerWsUrl,
  runnerWsToken,
  runnerWsEnabled,
  children,
}: AppProvidersProps) {
  return (
    <AppShellProvider value={appShell}>
      <AppSettingsProvider value={appSettings}>
        <PanelRuntimeStoreProvider value={panelRuntimeStore}>
          <PanelRuntimeControllerProvider value={panelRuntimeController}>
            <ConversationProvider value={conversation}>
              <AudioLabProvider value={audioLab}>
                <YouTubePlayerProvider value={youTubePlayer}>
                  <ChatDiagnosticsProvider value={chatDiagnostics}>
                    <ChatComposerProvider value={chatComposer}>
                      <ChatVisualProvider value={chatVisual}>
                        <ChatScreenProvider value={chatScreen}>
                          <DebugRuntimeProvider value={debugRuntime}>
                            <DebugConversationProvider value={debugConversation}>
                              <DebugSpeechProvider value={debugSpeech}>
                                <RunnerWsProvider
                                  url={runnerWsUrl}
                                  token={runnerWsToken}
                                  enabled={runnerWsEnabled}
                                >
                                  {children}
                                </RunnerWsProvider>
                              </DebugSpeechProvider>
                            </DebugConversationProvider>
                          </DebugRuntimeProvider>
                        </ChatScreenProvider>
                      </ChatVisualProvider>
                    </ChatComposerProvider>
                  </ChatDiagnosticsProvider>
                </YouTubePlayerProvider>
              </AudioLabProvider>
            </ConversationProvider>
          </PanelRuntimeControllerProvider>
        </PanelRuntimeStoreProvider>
      </AppSettingsProvider>
    </AppShellProvider>
  );
}
