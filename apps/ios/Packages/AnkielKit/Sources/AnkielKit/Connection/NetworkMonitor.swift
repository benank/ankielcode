import Foundation
import Network
import Synchronization

/// `NWPathMonitor` as a stream of "the OS thinks we are online" values, deduplicated. The first
/// value is the current state.
public enum NetworkMonitor {
  public static func paths() -> AsyncStream<Bool> {
    AsyncStream { continuation in
      let monitor = NWPathMonitor()
      let last = Mutex<Bool?>(nil)
      monitor.pathUpdateHandler = { path in
        let online = path.status == .satisfied
        let changed = last.withLock { value in
          defer { value = online }
          return value != online
        }
        if changed { continuation.yield(online) }
      }
      continuation.onTermination = { _ in monitor.cancel() }
      monitor.start(queue: DispatchQueue(label: "com.ankiel.code.network"))
    }
  }

}
