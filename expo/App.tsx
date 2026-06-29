import { useEffect } from "react";
import * as SplashScreen from "expo-splash-screen";

import AppRoot from "./src/features/app/AppRoot";

export default function App() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);

  return <AppRoot />;
}
