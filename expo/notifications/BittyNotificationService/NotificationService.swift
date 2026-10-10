import Foundation
import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var originalContent: UNNotificationContent?
  private let completionLock = NSLock()

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    originalContent = request.content
    let content = request.content
    let category = content.categoryIdentifier
    switch category {
    case "TURN_COMPLETED", "VOICE_COMPLETED", "APPROVAL_REQUEST", "SCHEDULE_FAILED", "CODEX_USAGE_LIMIT":
      break
    default:
      finish(content)
      return
    }
    let imageName = category.lowercased().replacingOccurrences(of: "_", with: "-")
    guard let imageURL = Bundle.main.url(forResource: imageName, withExtension: "png"),
      let imageData = try? Data(contentsOf: imageURL), !imageData.isEmpty else {
      finish(content)
      return
    }
    // A stable Bitty identity per purpose, never a contact or a new person per turn.
    let identity = "bitty-notification:\(category)"
    let sender = INPerson(
      personHandle: INPersonHandle(value: identity, type: .unknown),
      nameComponents: nil, displayName: content.title,
      image: INImage(imageData: imageData), contactIdentifier: nil,
      customIdentifier: identity, isMe: false, suggestionType: .none
    )
    let intent = INSendMessageIntent(
      recipients: nil, outgoingMessageType: .outgoingMessageText, content: content.body,
      speakableGroupName: nil,
      conversationIdentifier: content.threadIdentifier.isEmpty ? identity : content.threadIdentifier,
      serviceName: "Bitty", sender: sender, attachments: nil
    )
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { [weak self] error in
      guard let self = self else { return }
      guard error == nil, let updated = try? content.updating(from: intent),
        Self.preservesContract(updated, original: content) else {
        self.finish(content)
        return
      }
      // Apple requires the returned content to be passed on without mutation.
      self.finish(updated)
    }
  }

  // Decorating must not change routing, approval actions or unread counts.
  static func preservesContract(_ updated: UNNotificationContent, original: UNNotificationContent) -> Bool {
    return updated.categoryIdentifier == original.categoryIdentifier
      && NSDictionary(dictionary: updated.userInfo).isEqual(to: original.userInfo)
      && updated.badge == original.badge
      && updated.threadIdentifier == original.threadIdentifier
      && updated.interruptionLevel == original.interruptionLevel
  }

  private func finish(_ content: UNNotificationContent) {
    completionLock.lock()
    let handler = contentHandler
    contentHandler = nil
    completionLock.unlock()
    handler?(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let originalContent = originalContent { finish(originalContent) }
  }
}
