import { useEffect } from "react";
import * as SplashScreen from "expo-splash-screen";

import AppRoot from "./src/features/app/AppRoot";
import { AppModalHost } from "./src/features/app/components/AppModal";

export default function App() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);

  return (
    <AppModalHost>
      <AppRoot />
    </AppModalHost>
  );
}
