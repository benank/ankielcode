import AnkielKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The floating composer: a glass "+" for attachments beside a glass card that holds the
/// attachments, a growing text field, the model control and the send button. The send button
/// morphs between send, steer, queue and stop as the thread works (RN `ComposerToolbar` and
/// `composerSendPresentation`). Return adds a line; Command-Return sends.
struct ComposerView: View {
  let target: ComposerTarget
  var placeholder: LocalizedStringKey = "Message"
  /// Sends the draft with this delivery; the caller moves it to the outbox.
  let send: (MessageDelivery) -> Void
  var focusOnAppear = false

  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @FocusState private var focused: Bool
  @State private var picker: Picker?
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var notice: String?
  @State private var sends = 0
  @Namespace private var glass

  enum Picker: String, Identifiable {
    case photos, files, camera, model
    var id: String { rawValue }
  }

  private var store: ComposerStore { model.composer }
  private var draft: ComposerDraft { store.draft(target.draftKey) }
  private var actions: ComposerActions { ComposerActions(model: model, target: target) }

  private var selection: ModelSelection? { target.selection(draft, sticky: store.memory.lastModelSelection) }

  private var primary: ComposerPrimaryAction {
    ComposerPrimaryAction.resolve(
      hasContent: draft.hasContent, activity: target.activity,
      blocked: store.hasFailedUpload(target.draftKey, environmentId: target.environmentId) || !target.canSend
        || (target.isNewThread && selection == nil))
  }

  var body: some View {
    VStack(spacing: Spacing.sm) {
      if let notice = notice ?? blockNotice {
        Text(notice)
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, Spacing.lg)
          .transition(.opacity)
      }
      GlassEffectContainer(spacing: Spacing.sm) {
        HStack(alignment: .bottom, spacing: Spacing.sm) {
          attachMenu
            .glassEffectID("attach", in: glass)
          card
            .glassEffectID("card", in: glass)
        }
      }
    }
    .padding(.horizontal, Spacing.md)
    .padding(.bottom, Spacing.xs)
    .motion(Motion.micro, value: notice ?? blockNotice)
    .sensoryFeedback(.impact(weight: .medium), trigger: sends)
    .photosPicker(
      isPresented: isPresented(.photos), selection: $photoItems, maxSelectionCount: 10, matching: .images,
      preferredItemEncoding: .compatible)
    .fileImporter(isPresented: isPresented(.files), allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      if case .success(let urls) = result { Task { await addFiles(urls) } }
    }
    .fullScreenCover(isPresented: isPresented(.camera)) {
      CameraPicker { data in Task { await addImage(data, name: "photo.jpg", mimeType: "image/jpeg") } }
        .ignoresSafeArea()
    }
    .sheet(isPresented: isPresented(.model)) {
      ModelPickerSheet(target: target, actions: actions)
    }
    .onChange(of: photoItems) { _, items in
      guard !items.isEmpty else { return }
      photoItems = []
      Task { await addPhotos(items) }
    }
    .onAppear {
      if focusOnAppear { focused = true }
      #if DEBUG
        switch ProcessInfo.processInfo.environment["ANKIEL_DEBUG_COMPOSER_PRESET"] {
        case "picker": picker = .model
        case "keyboard", "multiline": focused = true
        default: break
        }
      #endif
      if let environmentId = target.environmentId, target.connected {
        store.startUploads(for: target.draftKey, environmentId: environmentId)
      }
    }
    .onChange(of: target.threadSelection) { _, _ in actions.releaseAppliedPick() }
    .onChange(of: target.connected) { _, connected in
      if connected, let environmentId = target.environmentId {
        store.startUploads(for: target.draftKey, environmentId: environmentId)
      }
    }
  }

  private var blockNotice: String? {
    if !target.canSend { return String(localized: "This device can read this computer's threads but not send to them.") }
    if store.hasFailedUpload(target.draftKey, environmentId: target.environmentId) {
      return String(localized: "Retry or remove the failed attachment")
    }
    return nil
  }

  // MARK: Card

  private var card: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !draft.attachments.isEmpty {
        AttachmentStrip(target: target)
          .padding(.top, Spacing.sm + 2)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      TextField(placeholder, text: text, axis: .vertical)
        .font(Typography.body)
        .lineLimit(1...8)
        .focused($focused)
        .padding(.horizontal, Spacing.xs + 2)
        .padding(.top, Spacing.md)
        .padding(.bottom, Spacing.xs)
        .accessibilityIdentifier("composer.field")
        .onKeyPress(.return, phases: .down) { press in
          guard press.modifiers.contains(.command) else { return .ignored }
          submit(primary.delivery)
          return .handled
        }
      HStack(spacing: Spacing.sm) {
        modelChip
        Spacer(minLength: 0)
        sendCluster
      }
      .padding(.bottom, Spacing.sm)
    }
    .padding(.horizontal, Spacing.sm)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassEffect(.regular, in: .rect(cornerRadius: 24, style: .continuous))
    .motion(Motion.snappy, value: draft.attachments.map(\.id))
  }

  private var text: Binding<String> {
    Binding(get: { draft.text }, set: { store.setText($0, for: target.draftKey) })
  }

  // MARK: Attach

  private var attachMenu: some View {
    Menu {
      Button("Photo library", systemImage: "photo.on.rectangle") { picker = .photos }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button("Camera", systemImage: "camera") { picker = .camera }
      }
      Button("Files", systemImage: "folder") { picker = .files }
      if UIPasteboard.general.hasImages {
        Button("Paste image", systemImage: "doc.on.clipboard") { Task { await pasteImages() } }
      }
    } label: {
      Image(systemName: "plus")
        .font(Typography.body.weight(.semibold))
        .foregroundStyle(Palette.textPrimary)
        .frame(width: 44, height: 44)
        .contentShape(.circle)
    }
    .glassEffect(.regular.interactive(), in: .circle)
    .accessibilityLabel(Text("Add attachment"))
    .accessibilityIdentifier("composer.attach")
  }

  // MARK: Model

  @ViewBuilder
  private var modelChip: some View {
    let label = ModelCatalog.label(for: selection, providers: target.providers)
    if !label.model.isEmpty {
      Button {
        picker = .model
      } label: {
        HStack(spacing: Spacing.xs) {
          Text(label.model)
            .foregroundStyle(Palette.textPrimary)
          if let effort = label.effort {
            Text(effort)
              .foregroundStyle(Palette.textSecondary)
          }
          Image(systemName: "chevron.down")
            .font(Typography.caption2.weight(.semibold))
            .foregroundStyle(Palette.textTertiary)
        }
        .font(Typography.footnote.weight(.medium))
        .lineLimit(1)
        .padding(.horizontal, Spacing.md - 2)
        .frame(minHeight: 32)
        .background(Palette.fill, in: .capsule)
        .contentShape(.capsule)
        .frame(minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text("Model"))
      .accessibilityValue(Text([label.model, label.effort].compactMap { $0 }.joined(separator: ", ")))
      .accessibilityIdentifier("composer.model")
    }
  }

  // MARK: Send

  private var sendCluster: some View {
    HStack(spacing: Spacing.sm) {
      if primary == .steer {
        Button {
          submit(.queue)
        } label: {
          Image(systemName: "list.number")
            .font(Typography.subheadline.weight(.semibold))
            .foregroundStyle(Palette.textPrimary)
            .frame(width: 34, height: 34)
            .background(Palette.fill, in: .circle)
            .frame(width: 44, height: 44)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .transition(reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity))
        .accessibilityLabel(Text("Queue"))
        .accessibilityHint(Text("Sends after the current turn"))
        .accessibilityIdentifier("composer.queue")
      }
      Button {
        if primary == .stop { actions.stop() } else { submit(primary.delivery) }
      } label: {
        Image(systemName: icon)
          .font(Typography.subheadline.weight(.bold))
          .foregroundStyle(enabled ? Palette.onPrimaryButton : Palette.textTertiary)
          .contentTransition(.symbolEffect(.replace))
          .frame(width: 34, height: 34)
          .background(enabled ? Palette.primaryButton : Palette.fill, in: .circle)
          .frame(width: 44, height: 44)
          .contentShape(.circle)
      }
      .buttonStyle(.plain)
      .disabled(!enabled)
      .keyboardShortcut(.return, modifiers: .command)
      .accessibilityLabel(Text(label))
      .accessibilityIdentifier("composer.send")
    }
    .motion(Motion.snappy, value: primary)
  }

  private var enabled: Bool {
    if case .send(let enabled) = primary { return enabled }
    return true
  }

  private var icon: String {
    switch primary {
    case .send: "arrow.up"
    case .steer: "arrow.turn.left.up"
    case .queue: "list.number"
    case .stop: "stop.fill"
    case .update: "checkmark"
    }
  }

  private var label: LocalizedStringKey {
    switch primary {
    case .send: "Send"
    case .steer: "Steer"
    case .queue: "Queue"
    case .stop: "Stop"
    case .update: "Update queued message"
    }
  }

  private func submit(_ delivery: MessageDelivery) {
    guard draft.hasContent else { return }
    if case .send(false) = primary { return }
    sends += 1
    withMotion(Motion.snappy, reduceMotion: reduceMotion) { send(delivery) }
  }

  // MARK: Adding attachments

  private func isPresented(_ kind: Picker) -> Binding<Bool> {
    Binding(get: { picker == kind }, set: { if !$0, picker == kind { picker = nil } })
  }

  private func addPhotos(_ items: [PhotosPickerItem]) async {
    for (index, item) in items.enumerated() {
      guard let data = try? await item.loadTransferable(type: Data.self) else {
        show(String(localized: "Could not read a photo."))
        continue
      }
      let type = item.supportedContentTypes.first
      let ext = type?.preferredFilenameExtension ?? "jpg"
      await addImage(data, name: items.count == 1 ? "photo.\(ext)" : "photo-\(index + 1).\(ext)", mimeType: type?.preferredMIMEType)
    }
  }

  private func pasteImages() async {
    let images = UIPasteboard.general.images ?? []
    for image in images {
      guard let data = image.pngData() else { continue }
      await addImage(data, name: "pasted-image.png", mimeType: "image/png")
    }
  }

  private func addImage(_ data: Data, name: String, mimeType: String?) async {
    do {
      let fitted = try await ImageFitting.fit(data, mimeType: mimeType)
      let ext = fitted.mimeType.split(separator: "/").last.map(String.init) ?? "png"
      let base = (name as NSString).deletingPathExtension
      try await store.addAttachment(
        fitted.data, name: "\(base).\(ext == "jpeg" ? "jpg" : ext)", mimeType: fitted.mimeType, kind: .image,
        to: target.draftKey, environmentId: target.connected ? target.environmentId : nil)
    } catch let error as ComposerStore.AttachmentError {
      show(Self.message(error))
    } catch {
      show(String(localized: "An image exceeds the 10 MB attachment limit."))
    }
  }

  private func addFiles(_ urls: [URL]) async {
    for url in urls {
      let loaded: (Data, String)? = await Task.detached {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= AttachmentLimits.maxFileBytes,
          let data = try? Data(contentsOf: url)
        else { return nil }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return (data, mime)
      }.value
      guard let (data, mime) = loaded else {
        show(String(localized: "Files can be up to 50 MB."))
        continue
      }
      if mime.hasPrefix("image/") {
        await addImage(data, name: url.lastPathComponent, mimeType: mime)
        continue
      }
      do {
        try await store.addAttachment(
          data, name: url.lastPathComponent, mimeType: mime, kind: .file, to: target.draftKey,
          environmentId: target.connected ? target.environmentId : nil)
      } catch {
        show(Self.message(error))
      }
    }
  }

  private func show(_ message: String) {
    notice = message
    Task {
      try? await Task.sleep(for: .seconds(4))
      if notice == message { notice = nil }
    }
  }

  static func message(_ error: ComposerStore.AttachmentError) -> String {
    switch error {
    case .tooMany: String(localized: "Remove attachments until there are at most \(AttachmentLimits.maxAttachments).")
    case .tooLarge(isImage: true): String(localized: "An image exceeds the 10 MB attachment limit.")
    case .tooLarge(isImage: false): String(localized: "Files can be up to 50 MB.")
    case .unreadable: String(localized: "Could not read that file.")
    }
  }
}

/// The camera (`UIImagePickerController`; the simulator has none, so the menu hides it there).
private struct CameraPicker: UIViewControllerRepresentable {
  let picked: (Data) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let controller = UIImagePickerController()
    controller.sourceType = .camera
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let parent: CameraPicker
    init(_ parent: CameraPicker) { self.parent = parent }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
        parent.picked(data)
      }
      parent.dismiss()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
      parent.dismiss()
    }
  }
}
