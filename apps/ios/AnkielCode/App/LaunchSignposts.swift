import Darwin
import Foundation
import os

/// Launch milestones as signposts (Instruments' Points of Interest), with the time since the
/// process started. Debug builds also print them, so a launch's cost can be read from the console.
nonisolated enum LaunchSignposts {
  private static let signposter = OSSignposter(subsystem: "com.ankiel.code.native", category: .pointsOfInterest)

  /// When the kernel started this process.
  fileprivate static let processStart: Date = {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.size
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return .now }
    let start = info.kp_proc.p_un.__p_starttime
    return Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
  }()

  static func mark(_ name: StaticString) {
    let ms = Int(Date.now.timeIntervalSince(processStart) * 1000)
    signposter.emitEvent(name, "\(ms) ms after process start")
    #if DEBUG
      FileHandle.standardError.write(Data("launch: \(name) +\(ms) ms\n".utf8))
    #endif
  }
}

#if DEBUG
  extension LaunchSignposts {
    /// `ANKIEL_DEBUG_LAUNCH_STALLS=1`: for the first ten seconds, prints every main-thread stall
    /// over 100 ms (a UI test's accessibility queries wait on the main thread).
    static func watchStalls() {
      guard ProcessInfo.processInfo.environment["ANKIEL_DEBUG_LAUNCH_STALLS"] == "1" else { return }
      Thread.detachNewThread {
        let end = Date.now.addingTimeInterval(10)
        while Date.now < end {
          let sent = Date.now
          let answered = DispatchSemaphore(value: 0)
          DispatchQueue.main.async { answered.signal() }
          answered.wait()
          let ms = Int(Date.now.timeIntervalSince(sent) * 1000)
          if ms > 100 { FileHandle.standardError.write(Data("launch: main stall \(ms) ms ending +\(Int(Date.now.timeIntervalSince(processStart) * 1000)) ms\n".utf8)) }
          Thread.sleep(forTimeInterval: 0.02)
        }
      }
    }
  }
#endif
