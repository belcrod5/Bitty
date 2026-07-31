export type PopupChatSourceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PopupChatPresentation = "popup" | "fullscreen";

// セッションポップアップを開いた起点。表示ラッパー(SafeAreaの有無)の分岐に使う。
export type SessionPopupOrigin = "drawer" | "skia_board";
