import AnkielKit
import Foundation
import Synchronization

/// The probe's state file: secrets and the saved environment as one JSON document. For local
/// testing only; the app uses the Keychain.
final class FileCredentialStore: CredentialStore {
  private let url: URL
  private let entries: Mutex<[String: Data]>

  init(url: URL) throws {
    self.url = url
    if let data = try? Data(contentsOf: url) {
      entries = Mutex(try JSONDecoder().decode([String: Data].self, from: data))
    } else {
      entries = Mutex([:])
    }
  }

  func data(for key: String) -> Data? { entries.withLock { $0[key] } }

  func set(_ data: Data, for key: String) throws {
    try entries.withLock { entries in
      entries[key] = data
      try write(entries)
    }
  }

  func remove(_ key: String) throws {
    try entries.withLock { entries in
      entries[key] = nil
      try write(entries)
    }
  }

  private func write(_ entries: [String: Data]) throws {
    let data = try JSONEncoder().encode(entries)
    try data.write(to: url, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
}
