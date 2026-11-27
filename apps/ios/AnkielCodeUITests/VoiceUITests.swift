import XCTest

/// Dictation in the composer with the scripted engine (`ANKIEL_DEBUG_VOICE`): the simulator has
/// no microphone input to drive, so the real `SpeechAnalyzer` path is not covered here.
final class VoiceUITests: HomeUITestCase {
  func launchThread(voice: String) {
    launch([
      "ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1",
      "ANKIEL_DEBUG_VOICE": voice,
    ])
    XCTAssertTrue(app.buttons["composer.mic"].waitForExistence(timeout: 10))
  }

  var field: XCUIElement {
    app.descendants(matching: .any).matching(identifier: "composer.field").firstMatch
  }

  func testDictateLiveTextThenDone() {
    launchThread(voice: "listen")
    app.buttons["composer.mic"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["dictation.status"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["composer.send"].exists, "send is out of reach while dictating")
    let partial = expectation(for: NSPredicate(format: "value CONTAINS 'regression'"), evaluatedWith: field)
    wait(for: [partial], timeout: 8)
    shot("voice-listening")
    app.buttons["dictation.done"].tap()
    XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 5))
    let value = field.value as? String ?? ""
    XCTAssertTrue(value.hasPrefix("Add a regression"), "the transcript lands in the draft: \(value)")
    shot("voice-done")
  }

  func testCancelKeepsTheDraft() {
    launchThread(voice: "listen")
    app.buttons["composer.mic"].tap()
    let partial = expectation(for: NSPredicate(format: "value CONTAINS 'regression'"), evaluatedWith: field)
    wait(for: [partial], timeout: 8)
    app.buttons["dictation.cancel"].tap()
    XCTAssertTrue(app.buttons["composer.mic"].waitForExistence(timeout: 3))
    XCTAssertFalse((field.value as? String ?? "").contains("regression"))
  }

  func testModelDownloadShowsProgress() {
    launchThread(voice: "download")
    app.buttons["composer.mic"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["dictation.download"].waitForExistence(timeout: 5))
    shot("voice-download")
    XCTAssertTrue(app.descendants(matching: .any)["dictation.status"].waitForExistence(timeout: 8), "listening after the download")
    app.buttons["dictation.cancel"].tap()
  }

  func testDeniedMicrophoneOffersSettings() {
    launchThread(voice: "denied")
    app.buttons["composer.mic"].tap()
    XCTAssertTrue(app.buttons["dictation.openSettings"].waitForExistence(timeout: 5))
    shot("voice-denied")
  }

  func testBackgroundingKeepsWhatWasHeard() {
    launchThread(voice: "listen")
    app.buttons["composer.mic"].tap()
    let partial = expectation(for: NSPredicate(format: "value CONTAINS 'regression'"), evaluatedWith: field)
    wait(for: [partial], timeout: 8)
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(app.buttons["composer.mic"].waitForExistence(timeout: 5), "the session ended")
    XCTAssertTrue((field.value as? String ?? "").contains("regression"), "the words stayed in the draft")
    shot("voice-backgrounded")
  }
}
