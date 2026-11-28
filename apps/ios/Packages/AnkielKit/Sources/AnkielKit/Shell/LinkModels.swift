extension ThreadShell {
  public struct IssueLink: Sendable, Hashable, Codable {
    public var tracker: String
    public var host: String
    public var scope: String
    public var key: String
    public var projectId: String
    public var url: String
    public var source: WireEnum<Source>
    public var linkedAt: WireTimestamp
    public var displayKey: String
    public var title: String

    public enum Source: String, Sendable { case manual, agent }
  }
}
