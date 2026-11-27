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

// The IME draft stays in UIKit and is visible only above the user's keyboard.
final class BrowserCompositionPreview: UIInputView {
  private let label = UILabel()

  init() {
    super.init(frame: .zero, inputViewStyle: .keyboard)
    allowsSelfSizing = true
    autoresizingMask = .flexibleHeight
    clipsToBounds = true
    isUserInteractionEnabled = false
    backgroundColor = .secondarySystemBackground
    label.font = .systemFont(ofSize: 17)
    label.textColor = .label
    label.lineBreakMode = .byTruncatingHead
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var intrinsicContentSize: CGSize {
    CGSize(width: UIView.noIntrinsicMetric, height: label.text?.isEmpty == false ? ceil(label.font.lineHeight) + 16 : 0)
  }

  override func systemLayoutSizeFitting(_ targetSize: CGSize) -> CGSize {
    CGSize(width: targetSize.width, height: intrinsicContentSize.height)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let left = safeAreaInsets.left + 20
    let right = safeAreaInsets.right + 20
    label.frame = CGRect(x: left, y: 8, width: max(0, bounds.width - left - right), height: max(0, bounds.height - 16))
  }

  func show(_ text: String?) {
    guard label.text != text else { return }
    label.text = text
    invalidateIntrinsicContentSize()
    setNeedsLayout()
  }
}

final class BittyBrowserKeyboardView: ExpoView, UITextViewDelegate {
  let onInput = EventDispatcher()
  var nextRevision: String?
  var kind = "text"
  private var revision: String?
  private var resetting = false
  private let input = BrowserKeyboardTextView()
  private let compositionPreview = BrowserCompositionPreview()

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
    input.inputAccessoryView = compositionPreview
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
    compositionPreview.show(nil)
    input.resignFirstResponder()
    input.text = ""
    resetting = false
  }

  private func sendKey(_ key: String) {
    guard !resetting, let revision else { return }
    onInput(["focusRevision": revision, "key": key])
  }

  private func sendCommittedText() {
    updateCompositionPreview()
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

  private func updateCompositionPreview() {
    guard !resetting, revision != nil, let range = input.markedTextRange,
      let text = input.text(in: range), !text.isEmpty else {
      compositionPreview.show(nil)
      return
    }
    compositionPreview.show(input.isSecureTextEntry ? String(repeating: "•", count: text.count) : text)
  }

  func textViewDidChange(_ textView: UITextView) { sendCommittedText() }

  func textViewDidChangeSelection(_ textView: UITextView) { updateCompositionPreview() }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    if text == "\n" && textView.markedTextRange == nil {
      sendKey("Enter")
      return false
    }
    return true
  }
}
