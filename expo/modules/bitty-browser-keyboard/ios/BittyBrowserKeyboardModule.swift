import ExpoModulesCore
import UIKit

public class BittyBrowserKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BittyBrowserKeyboard")
    View(BittyBrowserKeyboardView.self) {
      Events("onInput")
      Prop("focusRevision") { (view: BittyBrowserKeyboardView, revision: String?) in view.nextRevision = revision }
      Prop("kind") { (view: BittyBrowserKeyboardView, kind: String) in view.kind = kind }
      OnViewDidUpdateProps { (view: BittyBrowserKeyboardView) in view.updateFocus() }
    }
  }
}

// UIKit owns marked text until the IME commits it. JavaScript receives no draft or composition buffer.
final class BrowserKeyboardTextView: UITextView {
  var committed: (() -> Void)?
  var emptyBackspace: (() -> Void)?

  override func unmarkText() {
    super.unmarkText()
    committed?()
  }

  override func deleteBackward() {
    if markedTextRange == nil && text.isEmpty {
      emptyBackspace?()
    } else {
      super.deleteBackward()
    }
  }
}

final class BittyBrowserKeyboardView: ExpoView, UITextViewDelegate {
  let onInput = EventDispatcher()
  var nextRevision: String?
  var kind = "text"
  private var revision: String?
  private var resetting = false
  private let input = BrowserKeyboardTextView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    input.delegate = self
    input.backgroundColor = .clear
    input.textColor = .clear
    input.tintColor = .clear
    input.font = .systemFont(ofSize: 1)
    input.autocorrectionType = .no
    input.spellCheckingType = .no
    input.autocapitalizationType = .none
    input.smartQuotesType = .no
    input.smartDashesType = .no
    input.smartInsertDeleteType = .no
    input.isScrollEnabled = false
    input.accessibilityElementsHidden = true
    input.committed = { [weak self] in self?.sendCommittedText() }
    input.emptyBackspace = { [weak self] in self?.sendKey("Backspace") }
    addSubview(input)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    input.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { revision = nil; discard() } else { updateFocus() }
  }

  func updateFocus() {
    guard nextRevision != revision else { return }
    // Invalidate the token before resigning: UIKit may finalize marked text while losing focus.
    revision = nil
    discard()
    guard let nextRevision, window != nil else { return }
    revision = nextRevision
    switch kind {
    case "email": input.keyboardType = .emailAddress
    case "url": input.keyboardType = .URL
    case "tel": input.keyboardType = .phonePad
    case "number": input.keyboardType = .numbersAndPunctuation
    default: input.keyboardType = .default
    }
    input.isSecureTextEntry = kind == "password"
    input.becomeFirstResponder()
  }

  private func discard() {
    resetting = true
    input.resignFirstResponder()
    input.text = ""
    resetting = false
  }

  private func sendKey(_ key: String) {
    guard !resetting, let revision else { return }
    onInput(["focusRevision": revision, "key": key])
  }

  private func sendCommittedText() {
    guard !resetting, let revision, input.markedTextRange == nil, !input.text.isEmpty else { return }
    let text = input.text ?? ""
    resetting = true
    input.text = ""
    resetting = false
    // Bound every event without splitting a surrogate pair or composed character sequence.
    var chunk = ""
    for character in text {
      if chunk.utf16.count + String(character).utf16.count > 4096 {
        if !chunk.isEmpty { onInput(["focusRevision": revision, "text": chunk]) }
        chunk = ""
      }
      if String(character).utf16.count <= 4096 { chunk.append(character) }
    }
    if !chunk.isEmpty { onInput(["focusRevision": revision, "text": chunk]) }
  }

  func textViewDidChange(_ textView: UITextView) { sendCommittedText() }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    if text == "\n" && textView.markedTextRange == nil {
      sendKey("Enter")
      return false
    }
    return true
  }
}
