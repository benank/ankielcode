import XCTest

/// The composer over fixture threads with the debug fake sink (`ANKIEL_DEBUG_COMPOSER`, no server).
final class ComposerUITests: HomeUITestCase {
  func open(_ extra: [String: String] = [:], reset: Bool = true) {
    var environment = ["ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_COMPOSER": "fake"]
    if reset { environment["ANKIEL_DEBUG_COMPOSER_RESET"] = "1" }
    launch(environment.merging(extra) { $1 })
    XCTAssertTrue(field.waitForExistence(timeout: 5))
  }

  var field: XCUIElement { app.textFields["composer.field"].exists ? app.textFields["composer.field"] : app.textViews["composer.field"] }
  var send: XCUIElement { app.buttons["composer.send"] }

  func testTypingAndSendingShowsThePendingMessageUntilTheServerHasIt() {
    open(["ANKIEL_DEBUG_COMPOSER": "slow"])
    XCTAssertFalse(send.isEnabled, "nothing to send yet")
    field.tap()
    field.typeText("Check the tide offsets")
    XCTAssertTrue(send.isEnabled)
    send.tap()
    let pending = app.descendants(matching: .any)["pending.sending"]
    XCTAssertTrue(pending.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Check the tide offsets"].exists)
    XCTAssertEqual(field.value as? String ?? "", "Message", "the field clears (placeholder shows)")
    shot("composer-sending")
  }

  func testSentMessageIsReconciledWithTheServerItem() {
    open()
    field.tap()
    field.typeText("Add a regression test")
    send.tap()
    // The fake accepts and the fixture feed shows the message: one bubble, no pending row.
    let bubble = app.staticTexts["Add a regression test"]
    XCTAssertTrue(bubble.waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["pending.sending"].waitForNonExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: "Add a regression test").count, 1)
    shot("composer-acknowledged")
  }

  func testRefusedMessageCanBeEditedBackIntoTheComposer() {
    open(["ANKIEL_DEBUG_COMPOSER": "fail"])
    field.tap()
    field.typeText("This will be refused")
    send.tap()
    let edit = app.buttons["pending.edit"]
    XCTAssertTrue(edit.waitForExistence(timeout: 5))
    shot("composer-failed")
    edit.tap()
    XCTAssertEqual(field.value as? String, "This will be refused")
    XCTAssertFalse(edit.exists)
  }

  /// Return adds a line instead of sending.
  func testReturnAddsALine() {
    open(["ANKIEL_DEBUG_COMPOSER": "slow"])
    field.tap()
    field.typeText("First line\nsecond line")
    XCTAssertEqual(field.value as? String, "First line\nsecond line")
    XCTAssertFalse(app.descendants(matching: .any)["pending.sending"].exists)
  }

  func testOfflineMessageWaitsAndCanBeDeleted() {
    open(["ANKIEL_DEBUG_COMPOSER": "offline"])
    field.tap()
    field.typeText("Send when back")
    send.tap()
    let delete = app.buttons["pending.delete"]
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    shot("composer-offline")
    delete.tap()
    XCTAssertTrue(app.staticTexts["Send when back"].waitForNonExistence(timeout: 5))
  }

  func testDraftSurvivesARelaunch() {
    open()
    field.tap()
    field.typeText("Half-written thought")
    // Leave the thread so the draft is saved, then relaunch without resetting the store.
    app.navigationBars.buttons.firstMatch.tap()
    sleep(1)
    app.terminate()
    open(reset: false)
    XCTAssertEqual(field.value as? String, "Half-written thought")
  }

  func testModelPickerChangesTheModelAndEffort() {
    open()
    let chip = app.buttons["composer.model"]
    XCTAssertTrue(chip.waitForExistence(timeout: 5))
    chip.tap()
    let low = app.buttons["modelPicker.option.effort.low"]
    XCTAssertTrue(low.waitForExistence(timeout: 5))
    low.tap()
    let sonnet = app.buttons["modelPicker.model.claude-sonnet-5-5"]
    for _ in 0..<5 where !sonnet.isHittable { app.swipeUp(velocity: .slow) }
    sonnet.tap()
    shot("composer-picker")
    app.buttons["modelPicker.done"].tap()
    XCTAssertTrue(chip.waitForExistence(timeout: 5))
    XCTAssertTrue((chip.value as? String ?? "").contains("Sonnet 5.5"), "\(chip.value ?? "")")
  }

  func testNewThreadOpensTheThreadWithItsFirstMessage() {
    launch(["ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1", "ANKIEL_DEBUG_ROUTE": "new-thread"])
    XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 5))
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("Chart the spring tides")
    send.tap()
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5), "the new thread opens at once")
    XCTAssertTrue(app.staticTexts["Chart the spring tides"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["pending.sending"].waitForNonExistence(timeout: 5))
    shot("new-thread-opened")
  }
}

/// The composer against the dev server with the free Replay provider; skipped while it is down.
/// Starts a thread, sees its first message acknowledged, then deletes the thread.
final class LiveComposerUITests: HomeUITestCase {
  override func setUp() async throws {
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
  }

  func testNewThreadOnReplayIsAcknowledgedThenDeleted() throws {
    launch(["ANKIEL_DEBUG_ROUTE": "new-thread"])
    let model = app.buttons["composer.model"]
    XCTAssertTrue(model.waitForExistence(timeout: 15))
    model.tap()
    // Replay's models are its scenarios ("Showcase", "Multi turn", …); none is labeled "Replay".
    let replay = app.buttons["modelPicker.model.multi-turn"]
    for _ in 0..<6 where !replay.exists { app.swipeUp(velocity: .slow) }
    guard replay.exists else { throw XCTSkip("Replay (dev) is not registered on this server.") }
    replay.tap()
    app.buttons["modelPicker.done"].tap()
    let field = app.textViews["composer.field"].exists ? app.textViews["composer.field"] : app.textFields["composer.field"]
    field.tap()
    field.typeText("Native composer live check")
    app.buttons["composer.send"].tap()
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["pending.sending"].waitForNonExistence(timeout: 20), "the launch is acknowledged")
    shot("live-composer")
    app.buttons["thread.menu"].tap()
    let more = app.buttons["More"].firstMatch
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    more.tap()
    let delete = app.buttons["Delete"].firstMatch
    // A tap while the long menu is still settling can be dropped.
    if !delete.waitForExistence(timeout: 3), more.isHittable { more.tap() }
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    delete.tap()
    app.alerts.buttons["Delete"].tap()
    XCTAssertTrue(app.buttons["thread.menu"].waitForNonExistence(timeout: 10), "deleting closes the thread")
  }
}
