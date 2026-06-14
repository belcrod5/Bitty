import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { styles } from "../styles";

export function WaveformDebugSpinner() {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      })
    );
    loop.start();
    return () => {
      loop.stop();
      rotation.stopAnimation();
      rotation.setValue(0);
    };
  }, [rotation]);

  const rotate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <View pointerEvents="none" style={styles.autoWaveSpinnerOverlay}>
      <Animated.View style={[styles.autoWaveSpinner, { transform: [{ rotate }] }]} />
    </View>
  );
}
