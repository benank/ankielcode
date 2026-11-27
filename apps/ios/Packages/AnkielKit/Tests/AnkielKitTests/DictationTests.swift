import Foundation
import Testing

@testable import AnkielKit

@MainActor
@Suite("Dictation")
struct DictationTests {
  func dictation(_ mode: FakeDictationEngine.Mode = .listen, access: MicrophoneAccess = .granted) -> Dictation {
    Dictation(
      engine: FakeDictationEngine(mode: mode, words: ["fix", "the", "buoy"], interval: .milliseconds(20)),
      access: { access }, locales: { ["en-US"] })
  }

  func wait(_ dictation: Dictation, until done: (Dictation) -> Bool) async {
    for _ in 0..<300 where !done(dictation) { try? await Task.sleep(for: .milliseconds(5)) }
  }

  @Test("live text shows after the draft, and Done commits it once")
  func listenAndFinish() async {
    let dictation = dictation()
    var commits: [String] = []
    dictation.start("thread-1", draft: "Please") { commits.append($0) }
    #expect(dictation.isBusy("thread-1"))
    await wait(dictation) { $0.transcript.contains("the") }
    #expect(dictation.display("thread-1", draft: "Please").hasPrefix("Please fix"))
    #expect(dictation.display("other", draft: "x") == "x")
    #expect(dictation.level > 0)
    dictation.finish()
    await wait(dictation) { !$0.isBusy }
    #expect(commits.count == 1)
    #expect(commits.first?.hasPrefix("Please fix the") == true)
    #expect(dictation.phase == .idle)
  }

  @Test("cancel leaves the draft alone")
  func cancel() async {
    let dictation = dictation()
    var commits: [String] = []
    dictation.start("k", draft: "Keep me") { commits.append($0) }
    await wait(dictation) { !$0.transcript.isEmpty }
    dictation.cancel()
    #expect(dictation.display("k", draft: "Keep me") == "Keep me")
    try? await Task.sleep(for: .milliseconds(100))
    #expect(commits.isEmpty)
    #expect(!dictation.isBusy)
  }

  @Test("a denied microphone and an unsupported language fail with what to do")
  func failures() async {
    let denied = dictation(access: .denied)
    denied.start("k", draft: "") { _ in }
    await wait(denied) { !$0.isBusy }
    #expect(denied.failure("k") == .microphoneDenied(canAsk: false))
    denied.dismissFailure("k")
    #expect(denied.phase == .idle)

    let unsupported = dictation(.unsupported)
    unsupported.start("k", draft: "") { _ in }
    await wait(unsupported) { !$0.isBusy }
    #expect(unsupported.failure("k") == .unsupportedLanguage)
  }

  @Test("a missing model downloads with progress before listening")
  func download() async {
    let dictation = dictation(.download)
    var progress: [Double] = []
    dictation.start("k", draft: "") { _ in }
    for _ in 0..<300 {
      if case .preparing(let value?) = dictation.phase, progress.last != value { progress.append(value) }
      if dictation.phase == .listening { break }
      try? await Task.sleep(for: .milliseconds(2))
    }
    #expect(dictation.phase == .listening)
    #expect(progress.first == 0)
    #expect(progress.count >= 2)
    dictation.cancel()
  }

  @Test("an interruption keeps what was heard")
  func interruption() async {
    let dictation = dictation(.interrupt)
    var commits: [String] = []
    dictation.start("k", draft: "") { commits.append($0) }
    await wait(dictation) { !$0.isBusy }
    #expect(commits == ["fix the buoy"] || commits == ["fix the"])
  }

  @Test("transcripts join drafts with one space, none for spaceless languages")
  func compose() {
    #expect(DictationText.compose(base: "", transcript: " hello ", locale: "en-US") == "hello")
    #expect(DictationText.compose(base: "Note:", transcript: "hello", locale: "en-US") == "Note: hello")
    #expect(DictationText.compose(base: "Line\n", transcript: "hello", locale: "en-US") == "Line\nhello")
    #expect(DictationText.compose(base: "日本語", transcript: "テスト", locale: "ja-JP") == "日本語テスト")
    #expect(DictationText.compose(base: "Keep", transcript: "  ", locale: nil) == "Keep")
  }

  @Test("levels step from the noise floor to full scale")
  func levels() {
    #expect(DictationLevel.step(decibels: -80) == 0)
    #expect(DictationLevel.step(decibels: -.infinity) == 0)
    #expect(DictationLevel.step(decibels: 0) == DictationLevel.steps)
    let middle = DictationLevel.step(decibels: -20)
    #expect(middle > 0 && middle < DictationLevel.steps)
    let samples: [Float] = [0.5, -0.5, 0.5, -0.5]
    let db = samples.withUnsafeBufferPointer(DictationLevel.decibels)
    #expect(abs(db - (-6.02)) < 0.1)
  }
}
