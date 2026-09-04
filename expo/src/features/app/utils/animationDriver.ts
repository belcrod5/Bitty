import { Platform } from "react-native";

// react-native-macos 0.81のFabricではNativeAnimated(useNativeDriver:true)が
// 動作せず、アニメーションが開始したまま完了しない(GitDiffPanelで実測:
// timingのcallbackがunmountまで呼ばれず値が初期値のまま)。macOS専用実装の
// AppModal.macos / AppDrawerLayout.macosは以前からJS駆動(false)を使っている。
// クロスプラットフォームのコンポーネントはこの定数でドライバを選ぶこと。
export const USE_NATIVE_ANIMATION_DRIVER = Platform.OS !== "macos";
