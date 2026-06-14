import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

export type BouncingDotsIndicatorProps = {
  color?: string;
  dotSize?: number;
  gap?: number;
  jumpHeight?: number;
  style?: StyleProp<ViewStyle>;
};

export function BouncingDotsIndicator(props: BouncingDotsIndicatorProps) {
  const {
    color = "#8b8b84",
    dotSize = 5,
    gap = 4,
    jumpHeight = 5,
    style,
  } = props;
  const progressRef = useRef(new Animated.Value(0));

  useEffect(() => {
    progressRef.current.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progressRef.current, {
        toValue: 1,
        duration: 1080,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => {
      loop.stop();
      progressRef.current.setValue(0);
    };
  }, []);

  return (
    <View
      style={[
        localStyles.root,
        {
          gap,
          minWidth: dotSize * 3 + gap * 2,
          minHeight: dotSize + jumpHeight,
        },
        style,
      ]}
    >
      {[0, 1, 2].map((index) => {
        const start = index * 0.18;
        return (
          <Animated.View
            key={index}
            style={[
              {
                width: dotSize,
                height: dotSize,
                borderRadius: dotSize / 2,
                backgroundColor: color,
                transform: [
                  {
                    translateY: progressRef.current.interpolate({
                      inputRange: [
                        0,
                        start,
                        start + 0.09,
                        start + 0.18,
                        1,
                      ],
                      outputRange: [
                        0,
                        0,
                        -jumpHeight,
                        0,
                        0,
                      ],
                      extrapolate: "clamp",
                    }),
                  },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const localStyles = StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
  },
});
