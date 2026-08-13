import {
  Circle,
  Group,
  Paragraph,
  RoundedRect,
  type SkParagraph,
} from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";
import type { SkiaBoardSection as Section } from "../utils/skiaBoardState";
import type { SkiaBoardSectionRect } from "../utils/skiaBoardSectionGeometry";

export function SkiaBoardSectionRegion({
  index,
  sections,
  section,
  initialRect,
  selected,
}: {
  index: number;
  sections: SharedValue<SkiaBoardSectionRect[]>;
  section: Section;
  initialRect: SkiaBoardSectionRect;
  selected: boolean;
}) {
  const transform = useDerivedValue(() => {
    const current = sections.value[index] || initialRect;
    return [{ translateX: current.x }, { translateY: current.y }];
  });
  const width = useDerivedValue(() => (sections.value[index] || initialRect).width);
  const height = useDerivedValue(() => (sections.value[index] || initialRect).height);
  return (
    <Group transform={transform}>
      {!section.borderOnly ? (
        <RoundedRect
          x={0}
          y={0}
          width={width}
          height={height}
          r={8}
          color={section.color}
          opacity={section.opacity}
        />
      ) : null}
      <RoundedRect
        x={0}
        y={0}
        width={width}
        height={height}
        r={8}
        color={selected ? "#2563eb" : section.color}
        opacity={selected ? 1 : Math.max(0.65, section.opacity)}
        style="stroke"
        strokeWidth={selected ? 2.5 : 1.5}
      />
    </Group>
  );
}

export function SkiaBoardSectionOverlay({
  index,
  sections,
  initialRect,
  selected,
  boardX,
  boardY,
  scale,
  labelParagraph,
}: {
  index: number;
  sections: SharedValue<SkiaBoardSectionRect[]>;
  initialRect: SkiaBoardSectionRect;
  selected: boolean;
  boardX: SharedValue<number>;
  boardY: SharedValue<number>;
  scale: SharedValue<number>;
  labelParagraph: SkParagraph;
}) {
  const left = useDerivedValue(() => {
    const current = sections.value[index] || initialRect;
    return boardX.value + current.x * scale.value;
  });
  const top = useDerivedValue(() => {
    const current = sections.value[index] || initialRect;
    return boardY.value + current.y * scale.value;
  });
  const right = useDerivedValue(() => {
    const current = sections.value[index] || initialRect;
    return boardX.value + (current.x + current.width) * scale.value;
  });
  const bottom = useDerivedValue(() => {
    const current = sections.value[index] || initialRect;
    return boardY.value + (current.y + current.height) * scale.value;
  });
  const labelY = useDerivedValue(() => top.value - 22);
  return (
    <>
      <Paragraph
        x={left}
        y={labelY}
        width={1000}
        paragraph={labelParagraph}
      />
      {selected ? (
        <>
          <Circle cx={left} cy={top} r={5} color="#ffffff" style="fill" />
          <Circle cx={left} cy={top} r={5} color="#2563eb" style="stroke" strokeWidth={2} />
          <Circle cx={right} cy={top} r={5} color="#ffffff" style="fill" />
          <Circle cx={right} cy={top} r={5} color="#2563eb" style="stroke" strokeWidth={2} />
          <Circle cx={right} cy={bottom} r={5} color="#ffffff" style="fill" />
          <Circle cx={right} cy={bottom} r={5} color="#2563eb" style="stroke" strokeWidth={2} />
          <Circle cx={left} cy={bottom} r={5} color="#ffffff" style="fill" />
          <Circle cx={left} cy={bottom} r={5} color="#2563eb" style="stroke" strokeWidth={2} />
        </>
      ) : null}
    </>
  );
}

export function SkiaBoardSectionDraft({
  draft,
  color,
}: {
  draft: SharedValue<SkiaBoardSectionRect>;
  color: string;
}) {
  const transform = useDerivedValue(() => [
    { translateX: draft.value.x },
    { translateY: draft.value.y },
  ]);
  const width = useDerivedValue(() => draft.value.width);
  const height = useDerivedValue(() => draft.value.height);
  return (
    <Group transform={transform}>
      <RoundedRect x={0} y={0} width={width} height={height} r={8} color={color} opacity={0.12} />
      <RoundedRect
        x={0}
        y={0}
        width={width}
        height={height}
        r={8}
        color={color}
        style="stroke"
        strokeWidth={2}
      />
    </Group>
  );
}
