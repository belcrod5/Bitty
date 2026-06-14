import { Image, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { styles } from "../styles";
import { CircularProgressRing } from "./CircularProgressRing";

const WAVEFORM_DOT_GIF = require("../../../../assets/images/waveform-dots.gif");

export type TtsWaveformPlayerProps = {
  isPlaybackActive: boolean;
  playButtonDisabled: boolean;
  onPressPlayStop: () => void;
  playbackRingProgress?: number;
  statusRingProgress?: number;
};

export function TtsWaveformPlayer(props: TtsWaveformPlayerProps) {
  const {
    isPlaybackActive,
    playButtonDisabled,
    onPressPlayStop,
    playbackRingProgress = 0,
    statusRingProgress = 0,
  } = props;

  return (
    <View style={styles.chatAudioBubble}>
      <View style={styles.chatTtsWaveformCard}>
        {isPlaybackActive ? (
          <Image source={WAVEFORM_DOT_GIF} style={styles.chatWaveformGif} />
        ) : null}
        <View style={styles.chatTtsPlayFloatingWrap}>
          <View style={styles.chatTtsGenerationRingWrap}>
            <CircularProgressRing
              size={36}
              strokeWidth={2}
              progress={statusRingProgress}
              trackColor="#dbeafe"
              progressColor="#0ea5e9"
            />
          </View>
          <View style={styles.chatTtsPlaybackRingWrap}>
            <CircularProgressRing
              size={32}
              strokeWidth={2}
              progress={playbackRingProgress}
              trackColor="#fecaca"
              progressColor="#dc2626"
            />
          </View>
          <TouchableOpacity
            style={[
              styles.chatAudioIconButton,
              isPlaybackActive && styles.chatAudioIconButtonActive,
              playButtonDisabled && styles.buttonDisabled,
            ]}
            onPress={onPressPlayStop}
            disabled={playButtonDisabled}
          >
            <Ionicons
              name={isPlaybackActive ? "stop" : "volume-high"}
              size={14}
              color="#1e293b"
            />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
