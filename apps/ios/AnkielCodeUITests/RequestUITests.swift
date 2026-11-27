import XCTest

/// Pending approvals, questions and secrets over fixture threads, answered through the debug fake
/// sink (`ANKIEL_DEBUG_COMPOSER`; no server). The fake resolves the fixture's request the way the
/// server would, so the card's whole life is covered: answer, sending, confirmation, gone.
final class RequestUITests: HomeUITestCase {
  func open(_ fixture: String, _ extra: [String: String] = [:]) {
    launch(
      ["ANKIEL_DEBUG_THREAD": fixture, "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"].merging(extra) { $1 })
  }

  func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
  var approval: XCUIElement { element("request.approval") }
  var question: XCUIElement { element("request.question") }
  var confirmation: XCUIElement { element("request.confirmation") }
  var composer: XCUIElement { app.textFields["composer.field"].exists ? app.textFields["composer.field"] : app.textViews["composer.field"] }

  func testAllowShowsSendingThenConfirmsAndTheCardLeaves() {
    open("approval-command")
    XCTAssertTrue(approval.waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Command approval"].exists)
    XCTAssertTrue(element("request.detail").label.contains("git push --force-with-lease"))
    shot("approval-command")
    app.buttons["approval.accept"].tap()
    shot("approval-sending")
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(confirmation.label.contains("Allowed"))
    shot("approval-confirmed")
    XCTAssertTrue(approval.waitForNonExistence(timeout: 5))
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
    shot("approval-resolved")
  }

  func testAMessageWhileAnApprovalWaitsDeclinesWithFeedback() {
    open("approval-command")
    XCTAssertTrue(approval.waitForExistence(timeout: 8))
    composer.tap()
    composer.typeText("Run it on the staging copy first")
    shot("approval-feedback-typing")
    app.buttons["composer.send"].tap()
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(confirmation.label.contains("Declined"))
    XCTAssertTrue(approval.waitForNonExistence(timeout: 5))
    XCTAssertEqual(composer.value as? String, "Message", "the feedback went to the approval, not into the feed")
  }

  func testRefusedAnswerReturnsToAnswerableWithAnError() {
    open("approval-file-change", ["ANKIEL_DEBUG_COMPOSER": "fail"])
    XCTAssertTrue(approval.waitForExistence(timeout: 8))
    app.buttons["approval.decline"].tap()
    XCTAssertTrue(element("request.error").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["approval.accept"].isEnabled, "the card can be answered again")
    shot("approval-error")
  }

  func testReadOnlySessionSeesTheCardWithoutActions() {
    open("approval-permission", ["ANKIEL_DEBUG_REQUESTS": "readonly"])
    XCTAssertTrue(approval.waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["approval.accept"].isEnabled)
    XCTAssertTrue(app.staticTexts["This connection cannot respond to approvals."].exists)
    shot("approval-readonly")
  }

  func testQueuedApprovalsCountDownToTheNext() {
    open("approvals-queued")
    XCTAssertTrue(approval.waitForExistence(timeout: 8))
    XCTAssertEqual(element("request.count").label, "Request 1 of 3")
    shot("approvals-queued")
    app.buttons["approval.accept"].tap()
    XCTAssertTrue(app.staticTexts["File change approval"].waitForExistence(timeout: 6))
    XCTAssertEqual(element("request.count").label, "Request 1 of 2")
    shot("approvals-queued-next")
  }

  func testRequestAnsweredElsewhereLeavesANotice() {
    // The fixture's request is resolved "on another device" 2.5 s after the thread loads.
    open("approval-file-read", ["ANKIEL_DEBUG_REQUESTS": "elsewhere"])
    let notice = element("request.notice")
    XCTAssertTrue(notice.waitForExistence(timeout: 12))
    XCTAssertTrue(notice.label.contains("Answered on another device"))
    XCTAssertTrue(approval.waitForNonExistence(timeout: 3))
    shot("approval-elsewhere")
  }

  func testExpiredRequestLeavesANotice() {
    open("question-single", ["ANKIEL_DEBUG_REQUESTS": "expire"])
    let notice = element("request.notice")
    XCTAssertTrue(notice.waitForExistence(timeout: 12))
    XCTAssertTrue(notice.label.contains("This request expired"))
    XCTAssertTrue(question.waitForNonExistence(timeout: 3))
    XCTAssertTrue(composer.waitForExistence(timeout: 3), "the composer returns")
    shot("question-expired")
  }

  func testSingleSelectAnswer() {
    open("question-single")
    XCTAssertTrue(question.waitForExistence(timeout: 8))
    XCTAssertFalse(composer.exists, "a question takes the composer's place")
    let submit = app.buttons["question.submit"]
    XCTAssertFalse(submit.isEnabled)
    app.buttons["question.option.Mean sea level"].tap()
    XCTAssertTrue(app.buttons["question.option.Mean sea level"].isSelected)
    XCTAssertTrue(submit.isEnabled)
    shot("question-single-selected")
    submit.tap()
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(question.waitForNonExistence(timeout: 5))
    XCTAssertTrue(composer.waitForExistence(timeout: 5), "the composer returns")
    XCTAssertTrue(app.staticTexts["Mean sea level"].waitForExistence(timeout: 5), "the answered row shows the answer")
    shot("question-answered-row")
  }

  func testMultiSelectAnswer() {
    open("question-multi")
    XCTAssertTrue(question.waitForExistence(timeout: 8))
    let submit = app.buttons["question.submit"]
    app.buttons["question.option.Currents"].tap()
    app.buttons["question.option.Buoys"].tap()
    XCTAssertTrue(app.buttons["question.option.Currents"].isSelected)
    XCTAssertTrue(app.buttons["question.option.Buoys"].isSelected)
    app.buttons["question.option.Currents"].tap()
    XCTAssertFalse(app.buttons["question.option.Currents"].isSelected)
    shot("question-multi-selected")
    submit.tap()
    XCTAssertTrue(question.waitForNonExistence(timeout: 6))
    XCTAssertTrue(app.staticTexts["Buoys"].waitForExistence(timeout: 5))
  }

  func testFreeTextAnswerWithTheKeyboard() {
    open("question-text")
    XCTAssertTrue(question.waitForExistence(timeout: 8))
    let field = app.textFields["question.field"]
    field.tap()
    field.typeText("Mill Reach pier")
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    XCTAssertTrue(app.buttons["question.submit"].isHittable, "the actions stay above the keyboard")
    shot("question-text-keyboard")
    field.typeText("\n")
    XCTAssertTrue(question.waitForNonExistence(timeout: 6), "Return submits the last question")
    XCTAssertTrue(app.staticTexts["Mill Reach pier"].waitForExistence(timeout: 5))
  }

  func testMultiStepForm() {
    open("question-steps")
    XCTAssertTrue(question.waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Question 1 of 3"].exists)
    let next = app.buttons["question.next"]
    XCTAssertFalse(next.isEnabled, "a step needs an answer before Next")
    app.buttons["question.option.Inlet"].tap()
    next.tap()
    XCTAssertTrue(app.staticTexts["Question 2 of 3"].waitForExistence(timeout: 3))
    XCTAssertTrue(next.isEnabled, "an optional multi-select can be left empty")
    shot("question-steps-2")
    app.buttons["question.previous"].tap()
    XCTAssertTrue(app.buttons["question.option.Inlet"].isSelected, "going back keeps the answer")
    next.tap()
    next.tap()
    XCTAssertTrue(app.staticTexts["Question 3 of 3"].waitForExistence(timeout: 3))
    let field = app.textViews["question.field"].exists ? app.textViews["question.field"] : app.textFields["question.field"]
    XCTAssertEqual(field.value as? String, "Add the north coast tide chart", "the suggested answer is filled in")
    field.tap()
    field.typeText("\nCovers Gull Rock too.")
    XCTAssertTrue(question.exists, "Return adds a line in a multi-line answer instead of submitting")
    let edited = field.value as? String ?? ""
    XCTAssertTrue(edited.contains("\nCovers Gull Rock too.") && edited.contains("Add the north coast tide chart"), edited)
    shot("question-steps-3")
    app.buttons["question.submit"].tap()
    XCTAssertTrue(question.waitForNonExistence(timeout: 6))
  }

  func testMessageModeQuestionCanBeDismissed() {
    open("question-message")
    XCTAssertTrue(question.waitForExistence(timeout: 8))
    app.buttons["question.dismiss"].tap()
    XCTAssertTrue(question.waitForNonExistence(timeout: 6))
  }

  func testSecretIsSavedAndTheFieldEmpties() {
    open("secret")
    let field = app.secureTextFields["secret.field."]
    XCTAssertTrue(field.waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["secret.save"].isEnabled)
    field.tap()
    field.typeText("hf_synthetic_0000")
    shot("secret-typed")
    app.buttons["secret.save"].tap()
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    XCTAssertTrue(element("request.secret").waitForNonExistence(timeout: 6))
  }

  func testLargeTextKeepsTheActionsReachable() {
    launch([
      "ANKIEL_DEBUG_THREAD": "approval-command", "ANKIEL_DEBUG_COMPOSER": "fake",
    ])
    app.terminate()
    app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
    app.launch()
    XCTAssertTrue(approval.waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons["approval.accept"].isHittable)
    XCTAssertTrue(app.buttons["approval.decline"].isHittable)
    shot("approval-large-text")
  }
}
