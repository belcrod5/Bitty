import { useEffect } from "react";
import * as SplashScreen from "expo-splash-screen";

import AppRoot from "./src/features/app/AppRoot";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

let splashHidden = false;

function hideSplashScreen() {
  if (splashHidden) return;
  void SplashScreen.hideAsync()
    .then(() => { splashHidden = true; })
    .catch(() => undefined);
}

export default function App() {
  useEffect(() => {
    const fallback = setTimeout(hideSplashScreen, 5_000);
    return () => clearTimeout(fallback);
  }, []);

  return <AppRoot onReady={hideSplashScreen} />;
}
