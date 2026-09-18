import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

export function createAudioControlStyles(theme: VisualTheme) {
  return {
    autoWaveformCard: {
      marginTop: 6,
      borderWidth: theme.borders.thin,
      borderColor: theme.tones.neutral.border,
      borderRadius: 10,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    autoWaveformGif: {
      borderRadius: 8,
      opacity: 0.84,
    },
    autoWaveformGifActive: {
      opacity: 1,
    },
  } as const;
}

export const audioControlStylesByTheme = createStylesByTheme(createAudioControlStyles);
