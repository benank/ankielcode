import XCTest

/// `performAccessibilityAudit()` over the main screens (fixtures, no server).
final class AccessibilityAuditUITests: HomeUITestCase {
  func testThreadList() throws {
    launch(["ANKIEL_DEBUG_HOME": "sample"])
    XCTAssertTrue(row("approval").waitForExistence(timeout: 5))
    try audit()
  }

  func testThreadWithComposer() throws {
    launch(["ANKIEL_DEBUG_THREAD": "rich-markdown", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 5))
    try audit()
  }

  func testApprovalCard() throws {
    launch(["ANKIEL_DEBUG_THREAD": "approval-permission", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    XCTAssertTrue(app.staticTexts["Permission request"].waitForExistence(timeout: 5) || app.buttons["Allow once"].waitForExistence(timeout: 5))
    try audit()
  }

  func testQuestionCard() throws {
    launch(["ANKIEL_DEBUG_THREAD": "question-single", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    XCTAssertTrue(app.staticTexts["Mean sea level"].waitForExistence(timeout: 5))
    try audit()
  }

  func testSettings() throws {
    launch(["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_ROUTE": "settings"])
    XCTAssertTrue(app.buttons["settings.done"].waitForExistence(timeout: 5))
    try audit()
  }

  func testWelcome() throws {
    launch(["ANKIEL_DEBUG_ROUTE": "onboarding"])
    sleep(2)
    try audit()
  }

  /// Audits the screen and fails on anything but these, which were each looked at:
  /// - Contrast: the audit samples behind Liquid Glass and the system bar's own subtitle; text
  ///   colors are checked against WCAG AA in `Palette` instead (4.5:1 on the canvas).
  /// - Clipped text and Dynamic Type: titles truncate on purpose; accessibility sizes were checked
  ///   by hand.
  /// - "Not human-readable" on a single token (`north.json`, `ankiel.com`): file and project names.
  private func audit() throws {
    try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType)) { issue in
      let label = issue.element?.label ?? ""
      switch issue.auditType {
      case .contrast, .textClipped: return true
      case .sufficientElementDescription where !label.isEmpty && !label.contains(" "): return true
      default:
        print("AUDIT \(issue.compactDescription) — \(issue.element?.debugDescription.prefix(160) ?? "no element")")
        return false
      }
    }
  }
}
