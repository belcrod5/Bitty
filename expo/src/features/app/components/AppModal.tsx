import type { ReactNode } from "react";
import { Modal } from "react-native";
import type { AppModalProps } from "./AppModal.contract";

export function AppModalHost({ children }: { children: ReactNode }) {
  return children;
}

export function AppModal(props: AppModalProps) {
  return <Modal {...props} />;
}
