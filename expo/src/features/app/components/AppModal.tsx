import { createContext, useContext, type ReactNode } from "react";
import { Modal } from "react-native";
import type { AppModalHostProps, AppModalProps } from "./AppModal.contract";

const ForegroundContext = createContext<ReactNode>(null);

export function AppModalHost({ children, foreground }: AppModalHostProps) {
  return (
    <ForegroundContext.Provider value={foreground}>
      {children}
      {foreground}
    </ForegroundContext.Provider>
  );
}

export function AppModal({ children, ...props }: AppModalProps) {
  const foreground = useContext(ForegroundContext);
  return <Modal {...props}>{children}{foreground}</Modal>;
}
