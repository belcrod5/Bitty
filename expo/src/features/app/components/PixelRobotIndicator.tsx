import { useEffect, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { Image, View } from "react-native";
import { styles } from "../styles";

export type PixelRobotIndicatorProps = {
  active: boolean;
  activeSource: ImageSourcePropType;
  idleSource: ImageSourcePropType;
};

export function PixelRobotIndicator(props: PixelRobotIndicatorProps) {
  const { active, activeSource, idleSource } = props;
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!active) {
      setOffset({ x: 0, y: 0 });
      return;
    }
    const randomOffset = () => ({
      x: Math.floor(Math.random() * 5) - 2,
      y: Math.floor(Math.random() * 5) - 2,
    });
    setOffset(randomOffset());
    const timer = setInterval(() => {
      setOffset(randomOffset());
    }, 130);
    return () => clearInterval(timer);
  }, [active]);

  return (
    <View style={styles.pixelRobotWrap}>
      <Image
        source={active ? activeSource : idleSource}
        style={[
          styles.pixelRobotImage,
          active && { transform: [{ translateX: offset.x }, { translateY: offset.y }] },
        ]}
        resizeMode="contain"
      />
    </View>
  );
}
