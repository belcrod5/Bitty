import { createElement, Fragment, type PropsWithChildren } from "react";
import {
  KeyboardAvoidingView as NativeKeyboardAvoidingView,
  type KeyboardAvoidingViewProps as NativeKeyboardAvoidingViewProps,
} from "react-native";

type KeyboardAvoidingViewProps = Omit<NativeKeyboardAvoidingViewProps, "behavior"> & {
  automaticOffset?: boolean;
  behavior?: NativeKeyboardAvoidingViewProps["behavior"] | "translate-with-padding";
};

export function KeyboardProvider({ children }: PropsWithChildren) {
  return createElement(Fragment, null, children);
}

export function KeyboardAvoidingView({
  automaticOffset: _automaticOffset,
  behavior,
  ...props
}: KeyboardAvoidingViewProps) {
  return createElement(NativeKeyboardAvoidingView, {
    ...props,
    behavior: behavior === "translate-with-padding" ? "padding" : behavior,
  });
}
