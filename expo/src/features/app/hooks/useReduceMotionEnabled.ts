import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReduceMotionEnabled() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setEnabled(value);
      })
      .catch(() => {
        if (mounted) setEnabled(false);
      });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setEnabled);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return enabled;
}
