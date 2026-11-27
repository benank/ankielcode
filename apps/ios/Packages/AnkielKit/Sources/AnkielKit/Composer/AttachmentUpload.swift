import Foundation

/// `attachments.createUploadUrl` (spec §8.3). Images omit `type`.
struct UploadURLRequest: Encodable, Sendable {
  static let rpcTag = "attachments.createUploadUrl"
  var type: String?
  var name: String
  var mimeType: String
  var sizeBytes: Int

  init(_ file: UploadFile) {
    type = file.kind == .file ? "file" : nil
    name = file.name
    mimeType = file.mimeType
    sizeBytes = file.sizeBytes
  }

  enum CodingKeys: String, CodingKey { case type, name, mimeType, sizeBytes }

  func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(type, forKey: .type)
    try c.encode(name, forKey: .name)
    try c.encode(mimeType, forKey: .mimeType)
    try c.encode(sizeBytes, forKey: .sizeBytes)
  }
}

struct UploadURLResult: Decodable, Sendable {
  var attachmentId: String
  var relativeUrl: String
}

struct DeleteAttachmentRequest: Encodable, Sendable {
  static let rpcTag = "attachments.delete"
  var attachmentId: String
}

/// The signed POST: raw bytes, exact `Content-Length`, no auth header (the URL is the credential).
enum AttachmentTransfer {
  static func post(
    _ file: UploadFile, to url: URL, session: URLSession, progress: @escaping @Sendable (Double) -> Void
  ) async throws(EnvironmentRequestError) {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue(file.mimeType, forHTTPHeaderField: "Content-Type")
    request.setValue(String(file.sizeBytes), forHTTPHeaderField: "Content-Length")
    let response: URLResponse
    let data: Data
    do {
      (data, response) = try await session.upload(for: request, fromFile: file.url, delegate: ProgressDelegate(progress))
    } catch let error as URLError where error.code == .cancelled {
      throw .failed("Cancelled.")
    } catch {
      throw .failed(error.localizedDescription)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let body = String(decoding: data.prefix(300), as: UTF8.self)
      // 400 bad size, 404 expired link, 409 already uploaded: none of them gets better by resending.
      throw (400..<500).contains(status) ? .rejected(message: body.isEmpty ? nil : body) : .failed("HTTP \(status)")
    }
    progress(1)
  }

  final class ProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let report: @Sendable (Double) -> Void
    init(_ report: @escaping @Sendable (Double) -> Void) { self.report = report }

    func urlSession(
      _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
      totalBytesExpectedToSend: Int64
    ) {
      guard totalBytesExpectedToSend > 0 else { return }
      report(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
  }
}

extension EnvironmentRegistry: ComposerSink {
  /// Reads `activeRoute` (observed, set with the session) so views follow connects and drops.
  public func canSend(to environmentId: String) -> Bool {
    environment(environmentId)?.activeRoute != nil
  }

  public func send(_ command: ThreadCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
    try await dispatch(command, in: environmentId)
  }

  public func send(_ message: MessageDispatch, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
    try await request(environmentId) { session in
      try await session.call(ThreadCommand.rpcTag, payload: message, as: DispatchResult.self).sequence
    }
  }

  public func launch(_ launch: ThreadLaunch, in environmentId: String) async throws(EnvironmentRequestError) -> ThreadLaunchResult {
    try await request(environmentId) { session in
      try await session.call(ThreadLaunch.rpcTag, payload: launch, as: ThreadLaunchResult.self)
    }
  }

  public func upload(
    _ file: UploadFile, in environmentId: String, progress: @escaping @Sendable (Double) -> Void
  ) async throws(EnvironmentRequestError) -> String {
    guard let model = environment(environmentId), let endpoint = model.activeRoute?.endpoint else { throw .notConnected }
    if model.capabilities["attachmentUploads"]?.boolValue == false {
      throw .rejected(message: nil)
    }
    let ticket = try await request(environmentId) { session in
      try await session.call(UploadURLRequest.rpcTag, payload: UploadURLRequest(file), as: UploadURLResult.self)
    }
    guard let url = endpoint.resolve(relativeURL: ticket.relativeUrl) else { throw .failed("Unreadable upload URL.") }
    do {
      try await AttachmentTransfer.post(file, to: url, session: uploadSession, progress: progress)
    } catch {
      await discardUpload(ticket.attachmentId, in: environmentId)
      throw error
    }
    return ticket.attachmentId
  }

  public func discardUpload(_ attachmentId: String, in environmentId: String) async {
    _ = try? await request(environmentId) { session in
      try await session.call(DeleteAttachmentRequest.rpcTag, payload: DeleteAttachmentRequest(attachmentId: attachmentId), as: JSONValue.self)
    }
  }

  public func threadLaunched(_ result: ThreadLaunchResult, in environmentId: String) {
    seedThread(ThreadRef(environmentId: environmentId, threadId: result.threadId), result: result)
  }

  /// `projects.ensureScratch`: the project for threads without one.
  public func ensureScratchProject(in environmentId: String) async throws(EnvironmentRequestError) -> String {
    try await request(environmentId) { session in
      try await session.call(EnsureScratchRequest.rpcTag, payload: EnsureScratchRequest(), as: EnsureScratchResult.self).projectId
    }
  }
}
