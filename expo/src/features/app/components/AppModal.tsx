import type { ReactNode } from "react";
import { Modal, type ModalProps } from "react-native";

export function AppModalHost({ children }: { children: ReactNode }) {
  return children;
}

export function AppModal(props: ModalProps) {
  return <Modal {...props} />;
}
