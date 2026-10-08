import { Animated } from "react-native";
import Svg, { Circle } from "react-native-svg";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export type CircularProgressRingProps = {
  size: number;
  strokeWidth: number;
  progress: number;
  animatedProgress?: Animated.Value;
  trackColor: string;
  progressColor: string;
};

export function CircularProgressRing(props: CircularProgressRingProps) {
  const {
    size,
    strokeWidth,
    progress,
    animatedProgress,
    trackColor,
    progressColor,
  } = props;
  const normalizedProgress = Math.max(0, Math.min(1, Number(progress || 0)));
  const center = size / 2;
  const radius = Math.max(0, center - strokeWidth / 2);
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedProgress);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle
        cx={center}
        cy={center}
        r={radius}
        stroke={trackColor}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <AnimatedCircle
        cx={center}
        cy={center}
        r={radius}
        stroke={progressColor}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={animatedProgress
          ? animatedProgress.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] })
          : dashOffset}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </Svg>
  );
}
