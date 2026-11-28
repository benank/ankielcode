import Foundation

/// Which computers offer Issues. RN lists computers with `capabilities.issues` and shows the tab
/// only when one of them also has GitHub integration on (`issuesSupportedAtom`).
@MainActor
public enum IssueComputers {
  /// Computers whose issues can be read: GitHub integration on first, then connected ones.
  public static func choices(_ environments: [EnvironmentModel]) -> [EnvironmentModel] {
    let capable = environments.filter { $0.isEnabled && $0.capabilities["issues"]?.boolValue == true }
    func rank(_ environment: EnvironmentModel) -> Int {
      (offersIssues(environment) ? 0 : 2) + (environment.status.isConnected ? 0 : 1)
    }
    return capable.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
  }

  /// Whether home shows Issues at all.
  public static func available(_ environments: [EnvironmentModel]) -> Bool {
    environments.contains { $0.isEnabled && offersIssues($0) }
  }

  static func offersIssues(_ environment: EnvironmentModel) -> Bool {
    environment.capabilities["issues"]?.boolValue == true && environment.effectiveSettings.githubIntegrationEnabled
  }
}
