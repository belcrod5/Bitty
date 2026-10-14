# 通知音の出典

本番通知音は Kenney の [Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds) から採用。
作者・配布元は Kenney。素材のライセンスは CC0 1.0（[配布元のライセンス文](LICENSE-KENNEY.txt)）。
クレジット表記は必須ではないが、出典をここに保持する。

| 配布ファイル | 元パック内のファイル |
| --- | --- |
| `bitty-turn-completed.wav` | `Audio/confirmation_001.ogg` |
| `bitty-voice-completed.wav` | `Audio/confirmation_002.ogg` |
| `bitty-approval-request.wav` | `Audio/question_002.ogg` |
| `bitty-schedule-failed.wav` | `Audio/question_003.ogg` |
| `bitty-codex-usage-limit.wav` | `Audio/question_004.ogg` |

元OGGを44.1kHz・mono・16-bit linear PCM WAVへ変換し、ファイルごとに一定のゲインで音量を調整した。
音程変更、エフェクト追加、合成、フェード処理は行っていない。
ユーザーが実機で確認したWAVを保持し、アイコン生成スクリプトでは再生成しない。
