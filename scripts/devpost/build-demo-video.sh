#!/usr/bin/env bash
set -euo pipefail

DEVPOST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_ROOT="${1:-$(cd "$DEVPOST_ROOT/../.." && pwd)/devpost-artifacts}"
RECORDINGS="$ARTIFACT_ROOT/recordings"
OUTPUT="${2:-$ARTIFACT_ROOT/Bitty-Devpost-Demo.mp4}"
FONT="/System/Library/Fonts/SFNS.ttf"
BACKGROUND="0x09111f"

for command_name in ffmpeg ffprobe; do
  command -v "$command_name" >/dev/null || {
    echo "$command_name is required." >&2
    exit 1
  }
done

for source_file in \
  chat.mp4 \
  file.mp4 \
  location-rule.mp4 \
  arrival.mp4 \
  notifications.mp4; do
  source_path="$RECORDINGS/$source_file"
  [[ -f "$source_path" ]] || {
    echo "Missing recording: $source_path" >&2
    exit 1
  }
  source_absolute="$(cd -P "$(dirname "$source_path")" && pwd)/$(basename "$source_path")"
  output_absolute="$(cd -P "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
  [[ "$source_absolute" != "$output_absolute" ]] || {
    echo "Output must not overwrite a source recording: $source_path" >&2
    exit 1
  }
done

TEMP_DIR="$(mktemp -d -t bitty-devpost-video)"
trap 'rm -rf "$TEMP_DIR"' EXIT

encode_card() {
  local duration="$1"
  local output_file="$2"
  local heading="$3"
  local line_one="$4"
  local line_two="$5"
  local line_three="$6"

  ffmpeg -y -v error \
    -f lavfi -i "color=c=$BACKGROUND:s=1920x1080:r=30:d=$duration" \
    -vf "drawtext=fontfile=$FONT:text='$heading':fontcolor=white:fontsize=92:x=(w-text_w)/2:y=285,drawtext=fontfile=$FONT:text='$line_one':fontcolor=0x6ee7d8:fontsize=42:x=(w-text_w)/2:y=450,drawtext=fontfile=$FONT:text='$line_two':fontcolor=0xcbd5e1:fontsize=32:x=(w-text_w)/2:y=535,drawtext=fontfile=$FONT:text='$line_three':fontcolor=0x94a3b8:fontsize=26:x=(w-text_w)/2:y=625" \
    -an -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart \
    "$output_file"
}

encode_phone_scene() {
  local source_file="$1"
  local start_time="$2"
  local source_duration="$3"
  local speed="$4"
  local output_file="$5"
  local heading="$6"
  local line_one="$7"
  local line_two="$8"
  local line_three="$9"

  ffmpeg -y -v error \
    -ss "$start_time" -t "$source_duration" -i "$source_file" \
    -f lavfi -i "color=c=$BACKGROUND:s=1920x1080:r=30" \
    -filter_complex "[0:v]setpts=(PTS-STARTPTS)/$speed,scale=-2:900,setsar=1[phone];[1:v][phone]overlay=120:90:shortest=1,drawtext=fontfile=$FONT:text='$heading':fontcolor=white:fontsize=54:x=650:y=220,drawtext=fontfile=$FONT:text='$line_one':fontcolor=0x6ee7d8:fontsize=34:x=650:y=350,drawtext=fontfile=$FONT:text='$line_two':fontcolor=0xcbd5e1:fontsize=30:x=650:y=430,drawtext=fontfile=$FONT:text='$line_three':fontcolor=0x94a3b8:fontsize=28:x=650:y=510[v]" \
    -map "[v]" -an -r 30 -c:v libx264 -preset medium -crf 23 \
    -pix_fmt yuv420p -movflags +faststart -shortest "$output_file"
}

encode_card 6 "$TEMP_DIR/00-intro.mp4" \
  "Bitty" \
  "Control your local Codex from your iPhone or iPad." \
  "Local-first · macOS runner · iPhone Simulator" \
  "Developer Tools · Build Week Demo"

encode_phone_scene "$RECORDINGS/chat.mp4" 47 14 1 \
  "$TEMP_DIR/01-model.mp4" \
  "Start a local Codex session" \
  "GPT-5.6 Luna" \
  "Low reasoning" \
  "Create a fresh session without leaving iOS"

encode_phone_scene "$RECORDINGS/chat.mp4" 92 23 1.5 \
  "$TEMP_DIR/02-chat.mp4" \
  "Turn an idea into a file" \
  "English chat prompt" \
  "Taco dinner grocery checklist" \
  "Saved as a Markdown file in the local workspace"

encode_phone_scene "$RECORDINGS/file.mp4" 26 11 1 \
  "$TEMP_DIR/03-file.mp4" \
  "Inspect files and Git changes" \
  "Open the generated Markdown file" \
  "Review the real checklist on iPhone" \
  "No cloud workspace or rebuild required"

encode_phone_scene "$RECORDINGS/location-rule.mp4" 43 30 1.5 \
  "$TEMP_DIR/04-location.mp4" \
  "Schedule by location and time" \
  "Grocery Store geofence" \
  "GPT-5.6 Luna · Low reasoning" \
  "The scheduled reminder prompt is in English"

encode_phone_scene "$RECORDINGS/arrival.mp4" 24 12 1 \
  "$TEMP_DIR/05-arrival.mp4" \
  "Recover in the background" \
  "Bitty moves to the background" \
  "Simulator GPS enters the geofence" \
  "The scheduled Codex run is real"

ffmpeg -y -v error -ss 19.5 -i "$RECORDINGS/notifications.mp4" \
  -frames:v 1 "$TEMP_DIR/notification-frame.png"

ffmpeg -y -v error \
  -loop 1 -t 8 -i "$TEMP_DIR/notification-frame.png" \
  -f lavfi -i "color=c=$BACKGROUND:s=1920x1080:r=30:d=8" \
  -filter_complex "[0:v]split=2[notification][scheduled];[notification]crop=1120:310:42:1290,scale=1040:-2[notification_card];[scheduled]crop=1120:310:42:1965,scale=1040:-2[scheduled_card];[1:v][notification_card]overlay=760:220[with_notification];[with_notification][scheduled_card]overlay=760:640,drawtext=fontfile=$FONT:text='Arrival results':fontcolor=white:fontsize=58:x=120:y=245,drawtext=fontfile=$FONT:text='SIMULATED PUSH':fontcolor=0x6ee7d8:fontsize=30:x=760:y=165,drawtext=fontfile=$FONT:text='Notification delivery is simulated':fontcolor=0xcbd5e1:fontsize=24:x=120:y=370,drawtext=fontfile=$FONT:text='on iOS Simulator.':fontcolor=0xcbd5e1:fontsize=24:x=120:y=410,drawtext=fontfile=$FONT:text='REAL SCHEDULED RESULT':fontcolor=0x6ee7d8:fontsize=30:x=760:y=585,drawtext=fontfile=$FONT:text='The scheduled Codex run is real.':fontcolor=0xcbd5e1:fontsize=24:x=120:y=490[v]" \
  -map "[v]" -an -r 30 -t 8 -c:v libx264 -preset medium -crf 23 \
  -pix_fmt yuv420p -movflags +faststart "$TEMP_DIR/06-notifications.mp4"

encode_card 6 "$TEMP_DIR/07-outro.mp4" \
  "Bitty" \
  "Local Codex, in your pocket." \
  "github.com/belcrod5/Bitty · Version 1.0.0 · MIT" \
  "Developer Tools · Built with Codex"

printf "file '%s'\n" \
  "$TEMP_DIR/00-intro.mp4" \
  "$TEMP_DIR/01-model.mp4" \
  "$TEMP_DIR/02-chat.mp4" \
  "$TEMP_DIR/03-file.mp4" \
  "$TEMP_DIR/04-location.mp4" \
  "$TEMP_DIR/05-arrival.mp4" \
  "$TEMP_DIR/06-notifications.mp4" \
  "$TEMP_DIR/07-outro.mp4" > "$TEMP_DIR/concat.txt"

ffmpeg -y -v error -f concat -safe 0 -i "$TEMP_DIR/concat.txt" \
  -c copy -movflags +faststart "$OUTPUT"

duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTPUT")"
size="$(stat -f '%z' "$OUTPUT")"
echo "Created: $OUTPUT"
echo "Duration: $duration seconds"
echo "Size: $size bytes"
