import type { UnreadSessionCountSnapshot } from "../utils/sessionUnreadState";

export type PushNotificationRegistrarProps = {
  onUnreadCountSnapshot?: (snapshot: UnreadSessionCountSnapshot) => void;
};
