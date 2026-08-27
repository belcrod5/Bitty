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
import { SkiaBoardProvider } from "./contexts/SkiaBoardContext";

type AppProvidersProps = {
  appShell: AppShellContextValue;
  appSettings: AppSettingsContextValue;
  conversation: ConversationContextValue;
  panelRuntimeStore: PanelRuntimeStoreContextValue;
  panelRuntimeController: PanelRuntimeControllerContextValue;
  youTubePlayer: YouTubePlayerContextValue;
  chatDiagnostics: ChatDiagnosticsContextValue;
  chatComposer: ChatComposerContextValue;
  chatVisual: ChatVisualContextValue;
  chatScreen: ChatScreenContextValue;
  children: ReactNode;
};

export function AppProviders({
  appShell,
  appSettings,
  conversation,
  panelRuntimeStore,
  panelRuntimeController,
  youTubePlayer,
  chatDiagnostics,
  chatComposer,
  chatVisual,
  chatScreen,
  children,
}: AppProvidersProps) {
  return (
    <AppShellProvider value={appShell}>
      <AppSettingsProvider value={appSettings}>
        <PanelRuntimeStoreProvider value={panelRuntimeStore}>
          <PanelRuntimeControllerProvider value={panelRuntimeController}>
            <ConversationProvider value={conversation}>
              <YouTubePlayerProvider value={youTubePlayer}>
                <ChatDiagnosticsProvider value={chatDiagnostics}>
                  <ChatComposerProvider value={chatComposer}>
                    <ChatVisualProvider value={chatVisual}>
                      <ChatScreenProvider value={chatScreen}>
                        <SkiaBoardProvider>{children}</SkiaBoardProvider>
                      </ChatScreenProvider>
                    </ChatVisualProvider>
                  </ChatComposerProvider>
                </ChatDiagnosticsProvider>
              </YouTubePlayerProvider>
            </ConversationProvider>
          </PanelRuntimeControllerProvider>
        </PanelRuntimeStoreProvider>
      </AppSettingsProvider>
    </AppShellProvider>
  );
}
