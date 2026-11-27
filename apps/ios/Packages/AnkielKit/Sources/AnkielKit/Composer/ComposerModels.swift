import Foundation

/// A file the user attached to a draft, copied into the app's container so the draft survives a
/// relaunch. `uploaded` remembers the server's id per environment: an id is only valid where it
/// was minted, so switching computer uploads again.
public struct DraftAttachment: Sendable, Hashable, Codable, Identifiable {
  public var id: String
  public var kind: Kind
  public var name: String
  public var mimeType: String
  public var sizeBytes: Int
  /// The file's name inside the composer's files folder.
  public var fileName: String
  public var uploaded: Uploaded?

  public enum Kind: String, Sendable, Hashable, Codable { case image, file }

  public struct Uploaded: Sendable, Hashable, Codable {
    public var environmentId: String
    public var attachmentId: String
  }

  public init(
    id: String = UUID().uuidString.lowercased(), kind: Kind, name: String, mimeType: String, sizeBytes: Int,
    fileName: String, uploaded: Uploaded? = nil
  ) {
    self.id = id
    self.kind = kind
    self.name = name
    self.mimeType = mimeType
    self.sizeBytes = sizeBytes
    self.fileName = fileName
    self.uploaded = uploaded
  }

  public func uploadedId(in environmentId: String) -> String? {
    uploaded?.environmentId == environmentId ? uploaded?.attachmentId : nil
  }

  /// The wire reference once uploaded (spec §7.2).
  public func chatAttachment(id attachmentId: String) -> ChatAttachment {
    ChatAttachment(type: kind.rawValue, id: attachmentId, name: name, mimeType: mimeType, sizeBytes: sizeBytes)
  }
}

/// One composer's unsent state: per thread (`ThreadRef.key`) or per new-thread flow.
public struct ComposerDraft: Sendable, Hashable, Codable {
  public var text = ""
  public var attachments: [DraftAttachment] = []
  /// A pick not yet applied to the thread (or the new thread's pick).
  public var modelSelection: ModelSelection?
  public var runtimeMode: RuntimeMode?
  /// The new-thread flow's computer and project (nil: not chosen yet).
  public var environmentId: String?
  public var projectId: String?
  /// The new-thread flow chose "No project".
  public var noProject: Bool?

  public init() {}

  public var hasContent: Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
  }

  public var isEmpty: Bool {
    !hasContent && modelSelection == nil && runtimeMode == nil && projectId == nil && environmentId == nil && noProject == nil
  }
}

/// A message on its way to the server (RN thread outbox). It shows in the feed at once, survives a
/// relaunch until the server accepts it, and keeps its command id across retries so a resend after
/// a lost reply is answered from the server's receipt instead of running twice.
public struct OutboxMessage: Sendable, Hashable, Codable, Identifiable {
  public var environmentId: String
  public var threadId: String
  public var messageId: String
  public var commandId: String
  public var text: String
  public var attachments: [DraftAttachment]
  public var modelSelection: ModelSelection?
  /// A new thread's runtime mode; for an existing thread, a change to apply before the message.
  public var runtimeMode: RuntimeMode?
  /// A change to apply before the message (RN always sends mobile turns in the default mode).
  public var interactionMode: InteractionMode?
  public var delivery: MessageDelivery
  /// Set for the first message of a new thread (`orchestration.launchThread`).
  public var creation: Creation?
  public var createdAt: Date
  public var state: State

  public var id: String { messageId }
  public var threadKey: String { ThreadRef(environmentId: environmentId, threadId: threadId).key }

  public struct Creation: Sendable, Hashable, Codable {
    public var projectId: String
    public var title: String

    public init(projectId: String, title: String) {
      self.projectId = projectId
      self.title = title
    }
  }

  public enum State: Sendable, Hashable, Codable {
    /// Waiting its turn, or for the computer to connect.
    case queued
    case sending
    /// Not sent. `message` is the server's words when it sent any. `retriesSameCommand` is false
    /// after a refusal (a refused command id fails again with the stored error, so a retry mints a
    /// new one).
    case failed(message: String?, retriesSameCommand: Bool)
    /// The server accepted it at this event sequence; hidden once the feed shows it.
    case sent(sequence: Int?)

    public var isFailed: Bool { if case .failed = self { true } else { false } }
    public var isSent: Bool { if case .sent = self { true } else { false } }
  }

  public init(
    environmentId: String, threadId: String, messageId: String = UUID().uuidString.lowercased(),
    commandId: String = UUID().uuidString.lowercased(), text: String, attachments: [DraftAttachment] = [],
    modelSelection: ModelSelection? = nil, runtimeMode: RuntimeMode? = nil, interactionMode: InteractionMode? = nil,
    delivery: MessageDelivery = .start, creation: Creation? = nil, createdAt: Date = .now, state: State = .queued
  ) {
    self.environmentId = environmentId
    self.threadId = threadId
    self.messageId = messageId
    self.commandId = commandId
    self.text = text
    self.attachments = attachments
    self.modelSelection = modelSelection
    self.runtimeMode = runtimeMode
    self.interactionMode = interactionMode
    self.delivery = delivery
    self.creation = creation
    self.createdAt = createdAt
    self.state = state
  }
}

/// An upload's progress for one attachment in one environment.
public enum UploadState: Sendable, Hashable {
  case uploading(Double)
  case ready(attachmentId: String)
  case failed(String)
}

/// A file to upload (`attachments.createUploadUrl` then the signed POST, spec §8.3).
public struct UploadFile: Sendable, Hashable {
  public var url: URL
  public var kind: DraftAttachment.Kind
  public var name: String
  public var mimeType: String
  public var sizeBytes: Int

  public init(url: URL, kind: DraftAttachment.Kind, name: String, mimeType: String, sizeBytes: Int) {
    self.url = url
    self.kind = kind
    self.name = name
    self.mimeType = mimeType
    self.sizeBytes = sizeBytes
  }
}

/// Where the composer's commands go: the environment registry in the app, a fake in tests and
/// debug screenshots.
@MainActor
public protocol ComposerSink: AnyObject {
  /// The computer is connected right now.
  func canSend(to environmentId: String) -> Bool
  func send(_ command: ThreadCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int
  func send(_ message: MessageDispatch, in environmentId: String) async throws(EnvironmentRequestError) -> Int
  func launch(_ launch: ThreadLaunch, in environmentId: String) async throws(EnvironmentRequestError) -> ThreadLaunchResult
  /// Uploads one file and returns its attachment id. Cancelling the task cancels the transfer.
  func upload(
    _ file: UploadFile, in environmentId: String, progress: @escaping @Sendable (Double) -> Void
  ) async throws(EnvironmentRequestError) -> String
  /// Deletes an upload the user removed before sending (best effort).
  func discardUpload(_ attachmentId: String, in environmentId: String) async
  /// The launch result's projection, so a new thread renders before its stream starts.
  func threadLaunched(_ result: ThreadLaunchResult, in environmentId: String)
}

extension ComposerSink {
  public func threadLaunched(_ result: ThreadLaunchResult, in environmentId: String) {}
}

/// Limits from `chatAttachment.ts` (spec §7.2).
public enum AttachmentLimits {
  public static let maxAttachments = 100
  public static let maxImageBytes = 10 * 1024 * 1024
  public static let maxTotalImageBytes = 80 * 1024 * 1024
  public static let maxFileBytes = 50 * 1024 * 1024
  public static let maxTextCharacters = 120_000
  public static let imageMimeTypes: Set<String> = ["image/gif", "image/jpeg", "image/png", "image/webp"]
}
