#!/usr/bin/env bash
set -euo pipefail

DEVPOST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_ROOT="${1:-$(cd "$DEVPOST_ROOT/../.." && pwd)/devpost-artifacts}"
VIDEO="${2:-$ARTIFACT_ROOT/Bitty-Devpost-Demo.mp4}"
VOICE_DIR="${3:-$ARTIFACT_ROOT/voices}"
OUTPUT="${4:-$ARTIFACT_ROOT/Bitty-Devpost-Demo-Voiceover.mp4}"

for command_name in ffmpeg ffprobe awk; do
  command -v "$command_name" >/dev/null || {
    echo "$command_name is required." >&2
    exit 1
  }
done

[[ -f "$VIDEO" ]] || {
  echo "Missing silent demo video: $VIDEO" >&2
  exit 1
}

for voice_number in {1..8}; do
  [[ -f "$VOICE_DIR/$voice_number.mp4" ]] || {
    echo "Missing voice source: $VOICE_DIR/$voice_number.mp4" >&2
    exit 1
  }
done

video_absolute="$(cd -P "$(dirname "$VIDEO")" && pwd)/$(basename "$VIDEO")"
output_absolute="$(cd -P "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
[[ ! -L "$OUTPUT" ]] || {
  echo "Output must not be a symbolic link." >&2
  exit 1
}

if [[ -e "$OUTPUT" ]]; then
  for source_path in "$VIDEO" "$VOICE_DIR"/{1..8}.mp4; do
    [[ ! "$OUTPUT" -ef "$source_path" ]] || {
      echo "Output must not overwrite an input: $source_path" >&2
      exit 1
    }
  done
fi

[[ "$video_absolute" != "$output_absolute" ]] || {
  echo "Output must not overwrite the silent demo video." >&2
  exit 1
}

VIDEO_DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")"
CHORD_DURATION="$(awk -v duration="$VIDEO_DURATION" 'BEGIN { printf "%.6f", (duration + 4.5) / 4 }')"
FADE_OUT_START="$(awk -v duration="$VIDEO_DURATION" 'BEGIN { printf "%.6f", duration - 2.5 }')"

TEMP_DIR="$(mktemp -d -t bitty-devpost-audio)"
BGM="$TEMP_DIR/bitty-ambient.wav"
OUTPUT_TEMP="$(mktemp "$(dirname "$output_absolute")/.bitty-devpost-voiceover.XXXXXX")"

cleanup() {
  rm -rf "$TEMP_DIR"
  rm -f "$OUTPUT_TEMP"
}
trap cleanup EXIT

# Original ambient bed: Cmaj7 -> Am7 -> Fmaj7 -> Gsus2. It is synthesized
# entirely by ffmpeg, so the final demo does not depend on third-party music.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.04*(sin(2*PI*130.813*t)+0.60*sin(2*PI*195.998*t)+0.45*sin(2*PI*246.942*t)+0.30*sin(2*PI*329.628*t)):s=48000:d=$CHORD_DURATION" \
  -f lavfi -i "aevalsrc=0.04*(sin(2*PI*110.000*t)+0.60*sin(2*PI*164.814*t)+0.45*sin(2*PI*195.998*t)+0.30*sin(2*PI*261.626*t)):s=48000:d=$CHORD_DURATION" \
  -f lavfi -i "aevalsrc=0.04*(sin(2*PI*87.307*t)+0.60*sin(2*PI*130.813*t)+0.45*sin(2*PI*164.814*t)+0.30*sin(2*PI*220.000*t)):s=48000:d=$CHORD_DURATION" \
  -f lavfi -i "aevalsrc=0.04*(sin(2*PI*97.999*t)+0.60*sin(2*PI*146.832*t)+0.45*sin(2*PI*220.000*t)+0.30*sin(2*PI*293.665*t)):s=48000:d=$CHORD_DURATION" \
  -f lavfi -i "anoisesrc=color=pink:amplitude=0.002:sample_rate=48000:duration=$VIDEO_DURATION:seed=20260721" \
  -filter_complex "
    [0:a]highpass=f=70,lowpass=f=1800[c0];
    [1:a]highpass=f=70,lowpass=f=1800[c1];
    [2:a]highpass=f=70,lowpass=f=1800[c2];
    [3:a]highpass=f=70,lowpass=f=1800[c3];
    [c0][c1]acrossfade=d=1.5:c1=tri:c2=tri[x1];
    [x1][c2]acrossfade=d=1.5:c1=tri:c2=tri[x2];
    [x2][c3]acrossfade=d=1.5:c1=tri:c2=tri[x3];
    [x3]aecho=0.8:0.45:80|160:0.12|0.06[pad];
    [4:a]lowpass=f=1200,volume=0.03[air];
    [pad][air]amix=inputs=2:duration=first:normalize=0,
      atrim=duration=$VIDEO_DURATION,asetpts=PTS-STARTPTS,
      loudnorm=I=-30:LRA=5:TP=-8,
      afade=t=in:st=0:d=1.5,afade=t=out:st=$FADE_OUT_START:d=2.5,
      aformat=sample_rates=48000:channel_layouts=stereo[bgm]
  " \
  -map "[bgm]" -c:a pcm_s24le "$BGM"

ffmpeg -y -v error \
  -i "$VIDEO" \
  -i "$BGM" \
  -i "$VOICE_DIR/1.mp4" \
  -i "$VOICE_DIR/2.mp4" \
  -i "$VOICE_DIR/3.mp4" \
  -i "$VOICE_DIR/4.mp4" \
  -i "$VOICE_DIR/5.mp4" \
  -i "$VOICE_DIR/6.mp4" \
  -i "$VOICE_DIR/7.mp4" \
  -i "$VOICE_DIR/8.mp4" \
  -filter_complex "
    [2:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=700:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n0];
    [3:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=6500:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n1];
    [4:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=20500:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n2];
    [5:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=35500:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n3];
    [6:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=47000:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n4];
    [7:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=67000:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n5];
    [8:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=77300:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n6];
    [9:a]silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.08,
      areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.12,areverse,
      loudnorm=I=-16:LRA=7:TP=-2,asetpts=N/SR/TB,adelay=84300:all=1,asetpts=N/SR/TB,
      apad=whole_dur=$VIDEO_DURATION,atrim=duration=$VIDEO_DURATION[n7];
    [n0][n1][n2][n3][n4][n5][n6][n7]amix=inputs=8:duration=longest:normalize=0,
      alimiter=limit=0.95,asplit=2[narration_sidechain][narration_mix];
    [1:a]atrim=duration=$VIDEO_DURATION,asetpts=PTS-STARTPTS[bed];
    [bed][narration_sidechain]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=500:knee=4:detection=rms:link=average[ducked];
    [ducked][narration_mix]amix=inputs=2:duration=longest:normalize=0,
      loudnorm=I=-16:LRA=7:TP=-1.5,
      alimiter=limit=0.82:level=false:latency=true,
      atrim=duration=$VIDEO_DURATION[final_audio]
  " \
  -map 0:v:0 -map "[final_audio]" \
  -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart \
  -t "$VIDEO_DURATION" -f mp4 "$OUTPUT_TEMP"

chmod 0644 "$OUTPUT_TEMP"
mv -f "$OUTPUT_TEMP" "$OUTPUT"

echo "Created: $OUTPUT"
ffprobe -v error \
  -show_entries format=duration,size:stream=index,codec_type,codec_name,sample_rate,channels \
  -of default=nw=1 "$OUTPUT"
