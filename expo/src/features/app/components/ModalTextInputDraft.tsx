import { useCallback, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";

export type ModalTextInputDraftValue = {
  value: string;
  getValue: () => string;
  changeText: (value: string) => void;
};

type ModalTextInputDraftProps = {
  value: string;
  onChangeText: (value: string) => void;
  children: (draft: ModalTextInputDraftValue) => ReactNode;
};

export function ModalTextInputDraft({
  value,
  onChangeText,
  children,
}: ModalTextInputDraftProps) {
  const [macOSValue, setMacOSValue] = useState(value);
  const valueRef = useRef(value);
  const isMacOS = Platform.OS === "macos";

  if (!isMacOS) valueRef.current = value;

  const getValue = useCallback(() => valueRef.current, []);
  const changeText = useCallback((nextValue: string) => {
    valueRef.current = nextValue;
    if (isMacOS) setMacOSValue(nextValue);
    onChangeText(nextValue);
  }, [isMacOS, onChangeText]);

  return children({
    value: isMacOS ? macOSValue : value,
    getValue,
    changeText,
  });
}
