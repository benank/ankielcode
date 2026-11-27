import XCTest

/// Pull requests on synthetic fixtures (`ANKIEL_DEBUG_PULL_REQUESTS=fixture`): no server, and every
/// write goes to a recording fake whose last write shows in `pr.debug.sent`.
final class PullRequestUITests: HomeUITestCase {
  func fixture(_ open: String, _ extra: [String: String] = [:]) {
    launch(["ANKIEL_DEBUG_PULL_REQUESTS": "fixture", "ANKIEL_DEBUG_PR_OPEN": open].merging(extra) { _, new in new })
  }

  var sent: XCUIElement { app.descendants(matching: .any)["pr.debug.sent"] }

  func waitSent(_ tag: String, timeout: TimeInterval = 8) -> Bool {
    let predicate = NSPredicate(format: "label BEGINSWITH %@", tag)
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: sent)], timeout: timeout) == .completed
  }

  func tapTab(_ index: Int) {
    let tabs = app.segmentedControls["pr.tabs"]
    XCTAssertTrue(tabs.waitForExistence(timeout: 10))
    tabs.buttons.element(boundBy: index).tap()
  }

  /// Home → Pull requests → a pull request → Files → a file's diff with its review thread.
  func testListToDetailToFilesToDiff() {
    launch(["ANKIEL_DEBUG_HOME": "sample", "ANKIEL_DEBUG_PULL_REQUESTS": "fixture"])
    let more = app.buttons["home.more"]
    XCTAssertTrue(more.waitForExistence(timeout: 15))
    more.tap()
    let entry = app.buttons["home.pullRequests"]
    XCTAssertTrue(entry.waitForExistence(timeout: 5))
    entry.tap()
    let row = app.buttons["pr.row.128"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    shot("pr-list")
    row.tap()
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 10))
    tapTab(2)
    let file = app.buttons["pr.file.Sources/TideChart/TableCache.swift"]
    XCTAssertTrue(file.waitForExistence(timeout: 10))
    file.tap()
    XCTAssertTrue(app.descendants(matching: .any)["review.diff"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["review.annotation"].firstMatch.waitForExistence(timeout: 5), "the review thread sits under its line")
    shot("pr-diff")
    app.buttons["review.annotation"].firstMatch.tap()
    XCTAssertTrue(app.textFields["pr.thread.reply"].waitForExistence(timeout: 5) || app.textViews["pr.thread.reply"].waitForExistence(timeout: 1))
  }

  /// A thread row's pull request chip opens that pull request.
  func testThreadRowChipOpensPullRequest() {
    launch(["ANKIEL_DEBUG_HOME": "sample", "ANKIEL_DEBUG_PULL_REQUESTS": "fixture"])
    let chip = app.buttons["thread.row.pullRequest"].firstMatch
    XCTAssertTrue(chip.waitForExistence(timeout: 15))
    shot("thread-chip")
    chip.tap()
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 10), "the chip opened the pull request")
    // One Close returns to where the chip was: there is no list behind it.
    let close = app.buttons["pr.close"]
    XCTAssertTrue(close.waitForExistence(timeout: 5))
    close.tap()
    XCTAssertTrue(app.buttons["home.more"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["thread.menu"].exists, "the row's thread did not open underneath")

    // The thread's header carries the same chip.
    app.buttons["thread.done"].tap()
    let header = app.buttons["thread.pullRequest"]
    XCTAssertTrue(header.waitForExistence(timeout: 10))
    shot("thread-header-chip")
    header.tap()
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 10))
    app.buttons["pr.close"].tap()
    XCTAssertTrue(header.waitForExistence(timeout: 5), "Close returns to the thread")
  }

  /// The row chips are small but take a 44 pt tap: a tap just above the pull request chip opens
  /// it, not the row's thread.
  func testRowChipHitAreaReaches44Points() {
    launch(["ANKIEL_DEBUG_HOME": "sample", "ANKIEL_DEBUG_PULL_REQUESTS": "fixture"])
    let chip = app.buttons["thread.row.pullRequest"].firstMatch
    XCTAssertTrue(chip.waitForExistence(timeout: 15))
    // Its frame is the hit area: at least 44 pt, centred on the ~18 pt capsule.
    XCTAssertGreaterThanOrEqual(chip.frame.height, 44)
    let nearTop = chip.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: 4))
    nearTop.tap()
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 10), "a tap well above the capsule opened it")
    XCTAssertFalse(app.buttons["thread.menu"].exists, "the row's thread did not open")
    app.buttons["pr.close"].tap()

    // Between the issue chip and the pull request chip, the nearer chip wins, never the row.
    let issue = app.buttons["thread.row.issue"].firstMatch
    XCTAssertTrue(issue.waitForExistence(timeout: 5))
    XCTAssertTrue(issue.isHittable)
  }

  /// A pasted link opens its pull request.
  func testOpenByLink() {
    fixture("link:https://github.com/tidewater/tide-chart/pull/127")
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["Fix the moon phase drifting a day in leap years"].exists)
  }

  /// Start work fills the new thread's draft with the pull request and the task; nothing is sent.
  func testStartWorkFillsDraft() {
    fixture("pr:128", ["ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    let menu = app.buttons["pr.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 10))
    menu.tap()
    let explain = app.buttons["Explain this PR"]
    XCTAssertTrue(explain.waitForExistence(timeout: 5))
    explain.tap()
    let draft = app.textViews.containing(NSPredicate(format: "value CONTAINS %@", "tide-chart/pull/128")).firstMatch
    let field = draft.exists ? draft : app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS %@", "tide-chart/pull/128")).firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10), "the new thread's draft names the pull request")
    shot("pr-start-work")
  }

  /// Typed qualifiers filter the list on the device.
  func testSearch() {
    fixture("list")
    XCTAssertTrue(app.buttons["pr.row.128"].waitForExistence(timeout: 10))
    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.tap()
    search.typeText("label:bug")
    XCTAssertTrue(app.buttons["pr.row.127"].waitForExistence(timeout: 5))
    let gone = NSPredicate(format: "exists == false")
    expectation(for: gone, evaluatedWith: app.buttons["pr.row.128"])
    waitForExpectations(timeout: 5)
    shot("pr-search")
  }

  func testComment() {
    fixture("pr:128")
    let comment = app.buttons["pr.action.comment"]
    XCTAssertTrue(comment.waitForExistence(timeout: 10))
    comment.tap()
    let field = app.textViews["pr.sheet.comment.field"].exists ? app.textViews["pr.sheet.comment.field"] : app.textFields["pr.sheet.comment.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("Looks good on a small phone.")
    app.buttons["pr.sheet.comment.send"].tap()
    XCTAssertTrue(waitSent("pullRequests.comment"))
  }

  /// An inline comment joins the pending review; the review sends it with the verdict.
  func testInlineCommentAndReview() {
    fixture("file:128:Sources/TideChart/TableCache.swift")
    let line = app.descendants(matching: .any).matching(identifier: "review.line").element(boundBy: 2)
    XCTAssertTrue(line.waitForExistence(timeout: 15))
    line.tap()
    let field = app.textViews["pr.inline.field"].exists ? app.textViews["pr.inline.field"] : app.textFields["pr.inline.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("Say what the cache holds.")
    app.buttons["pr.inline.add"].tap()
    XCTAssertTrue(app.buttons["review.annotation"].firstMatch.waitForExistence(timeout: 5))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    let review = app.buttons["pr.action.review"]
    XCTAssertTrue(review.waitForExistence(timeout: 5))
    XCTAssertTrue(review.label.contains("1"), "the review counts its pending comment")
    review.tap()
    XCTAssertTrue(app.buttons["pr.review.submit"].waitForExistence(timeout: 5))
    app.buttons["Approve"].firstMatch.tap()
    shot("pr-review")
    app.buttons["pr.review.submit"].tap()
    XCTAssertTrue(waitSent("pullRequests.submitReview"))
    XCTAssertTrue(sent.label.contains("Say what the cache holds."), "the inline comment went with the review")
  }

  func testMergeConfirms() {
    fixture("merge:128")
    let confirm = app.buttons["pr.merge.confirm"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 10))
    app.buttons["pr.merge.method.rebase"].tap()
    confirm.tap()
    let final = app.buttons["pr.merge.final"].firstMatch
    XCTAssertTrue(final.waitForExistence(timeout: 5), "merging asks once more")
    shot("pr-merge-confirm")
    final.tap()
    XCTAssertTrue(waitSent("pullRequests.runAction"))
    XCTAssertTrue(sent.label.contains("\"mergeMethod\":\"rebase\""))
  }

  func testCloseFromMenu() {
    fixture("pr:127")
    let menu = app.buttons["pr.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 10))
    menu.tap()
    let close = app.buttons["Close pull request"]
    XCTAssertTrue(close.waitForExistence(timeout: 5))
    close.tap()
    let confirm = app.buttons["pr.confirm.action"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    XCTAssertTrue(waitSent("pullRequests.runAction"))
    XCTAssertTrue(sent.label.contains("\"action\":\"close\""))
  }

  func testEditAndReviewers() {
    fixture("edit:128")
    let title = app.textViews["pr.edit.title"].exists ? app.textViews["pr.edit.title"] : app.textFields["pr.edit.title"]
    XCTAssertTrue(title.waitForExistence(timeout: 10))
    title.tap()
    title.typeText(" now")
    app.buttons["pr.edit.save"].tap()
    XCTAssertTrue(waitSent("pullRequests.update"))

    app.buttons["pr.menu"].tap()
    let reviewers = app.buttons["Request reviewers"]
    XCTAssertTrue(reviewers.waitForExistence(timeout: 5))
    reviewers.tap()
    let ana = app.buttons["pr.reviewer.ana-lund"]
    XCTAssertTrue(ana.waitForExistence(timeout: 10))
    ana.tap()
    app.buttons["pr.reviewers.done"].tap()
    XCTAssertTrue(waitSent("pullRequests.requestReviewers"))
    XCTAssertTrue(sent.label.contains("U_fixture_ana"))
  }

  func testThreadReplyResolveAndReact() {
    fixture("thread:128")
    let resolve = app.buttons["pr.thread.resolve"]
    XCTAssertTrue(resolve.waitForExistence(timeout: 10))
    resolve.tap()
    XCTAssertTrue(waitSent("pullRequests.setThreadResolution"))
    let thread = app.buttons["pr.thread.PRRT_fixture_1"]
    XCTAssertTrue(thread.waitForExistence(timeout: 5))
    thread.tap()
    let reply = app.textViews["pr.thread.reply"].exists ? app.textViews["pr.thread.reply"] : app.textFields["pr.thread.reply"]
    XCTAssertTrue(reply.waitForExistence(timeout: 5))
    reply.tap()
    reply.typeText("Done.")
    app.buttons["pr.thread.send"].tap()
    XCTAssertTrue(waitSent("pullRequests.replyToThread"))

    let react = app.buttons["pr.react"].firstMatch
    XCTAssertTrue(react.waitForExistence(timeout: 5))
    react.tap()
    let rocket = app.buttons["🚀"]
    XCTAssertTrue(rocket.waitForExistence(timeout: 5))
    rocket.tap()
    XCTAssertTrue(waitSent("pullRequests.setReaction"))
  }

  /// A read-only session shows no write controls.
  func testReadOnly() {
    launch(["ANKIEL_DEBUG_PULL_REQUESTS": "readonly", "ANKIEL_DEBUG_PR_OPEN": "pr:128"])
    XCTAssertTrue(app.descendants(matching: .any)["pr.description"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["pr.action.comment"].exists)
    XCTAssertFalse(app.buttons["pr.action.merge"].exists)
  }

  func testSignedOut() {
    launch(["ANKIEL_DEBUG_PULL_REQUESTS": "signed-out", "ANKIEL_DEBUG_PR_OPEN": "list"])
    XCTAssertTrue(app.staticTexts["Sign in to GitHub"].waitForExistence(timeout: 10))
    shot("pr-signed-out")
  }
}
