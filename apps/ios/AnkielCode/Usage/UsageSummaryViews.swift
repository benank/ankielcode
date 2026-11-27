import AnkielKit
import Charts
import SwiftUI

/// Which view of usage Settings → Usage shows (RN `UsageRouteScreen` tabs).
enum UsageTab: String, Hashable, CaseIterable {
  case limits, cost, tokens

  var title: LocalizedStringResource {
    switch self {
    case .limits: LocalizedStringResource("Limits", comment: "usage view tab, subscription limits")
    case .cost: LocalizedStringResource("Cost", comment: "usage view tab")
    case .tokens: LocalizedStringResource("Tokens", comment: "usage view tab")
    }
  }
}

/// Cost or processed tokens on one computer over a window (RN usage Cost and Tokens tabs): a
/// chart by provider, the totals, and rankings by provider and model. The computer reads its
/// provider transcripts (`server.getUsageSummary`, needs `diagnostics:read`); the first answer is
/// its last scan, and a fresh scan follows.
struct UsageSummaryList: View {
  @Environment(AppModel.self) private var model
  let metric: UsageTab
  @State private var days = 30
  @State private var computerId: String?
  @State private var report: UsageReport?
  @State private var failure: String?
  @State private var loading = false

  private var computers: [EnvironmentModel] { model.registry.environments.filter { $0.isEnabled } }
  private var computer: EnvironmentModel? {
    computers.first { $0.id == computerId } ?? computers.first(where: \.status.isConnected) ?? computers.first
  }

  static let windows: [(days: Int, label: LocalizedStringResource, spoken: LocalizedStringResource)] = [
    (1, LocalizedStringResource("24h", comment: "short label for the past 24 hours"), "Past 24 hours"),
    (7, LocalizedStringResource("7d", comment: "short label for the past 7 days"), "Past 7 days"),
    (30, LocalizedStringResource("30d", comment: "short label for the past 30 days"), "Past 30 days"),
    (90, LocalizedStringResource("90d", comment: "short label for the past 90 days"), "Past 90 days"),
  ]

  var body: some View {
    List {
      Section {
        Picker("Window", selection: $days) {
          ForEach(Self.windows, id: \.days) { window in
            Text(window.label).tag(window.days).accessibilityLabel(Text(window.spoken))
          }
        }
        .pickerStyle(.segmented)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
        .accessibilityIdentifier("usage.window")
      }
      if computers.count > 1 {
        Section {
          Picker("Computer", selection: Binding(get: { computer?.id }, set: { computerId = $0 })) {
            ForEach(computers) { Text($0.label).tag(Optional($0.id)) }
          }
        }
      }

      if let notice {
        Section {
          Text(notice)
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textSecondary)
        }
      } else if let report {
        if report.isEmpty {
          Section {
            Text("No activity in this window.")
              .font(Typography.subheadline)
              .foregroundStyle(Palette.textSecondary)
          }
        } else {
          headline(report)
          providersSection(report)
          totalsSection(report)
          modelsSection(report)
        }
      }
    }
    .contentMargins(.top, Spacing.sm, for: .scrollContent)
    .overlay {
      if report == nil, notice == nil { ProgressView("Scanning provider transcripts…") }
    }
    .refreshable { await load(fresh: true) }
    .task(id: LoadKey(days: days, computer: computer?.id, connected: computer?.status.isConnected == true)) {
      await load(fresh: false)
      if report?.refreshing == true { await load(fresh: true) }
    }
  }

  private struct LoadKey: Hashable {
    var days: Int
    var computer: String?
    var connected: Bool
  }

  // MARK: Sections

  private func headline(_ report: UsageReport) -> some View {
    Section {
      VStack(alignment: .leading, spacing: Spacing.sm) {
        Text(metric == .cost ? "Raw token cost" : "Processed tokens")
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
        Text(metric == .cost ? UsageFormat.usd(report.costUsd) : UsageFormat.tokens(report.totals.processed))
          .font(.system(.largeTitle, design: .rounded).weight(.semibold))
          .monospacedDigit()
          .contentTransition(.numericText())
        Text(metric == .cost ? String(localized: "* if billed at full API rate") : String(localized: "Across \(report.sessions) sessions"))
          .font(Typography.footnote)
          .foregroundStyle(Palette.textTertiary)
        UsageChart(report: report, metric: metric, hourly: days == 1)
          .frame(height: 180)
          .padding(.top, Spacing.sm)
      }
      .padding(.vertical, Spacing.xs)
      .motion(Motion.microSlow, value: report)
    } header: {
      Text(days == 1 ? (metric == .cost ? "Hourly cost" : "Hourly processed tokens") : (metric == .cost ? "Daily cost" : "Daily processed tokens"))
    }
  }

  private func providersSection(_ report: UsageReport) -> some View {
    Section("Providers") {
      ForEach(report.providers) { share in
        ShareRow(
          title: UsageReport.providerLabel(share.provider), color: UsageFormat.color(share.provider),
          value: metric == .cost ? UsageFormat.usd(share.costUsd) : UsageFormat.tokens(share.tokens),
          detail: metric == .cost
            ? String(localized: "\(UsageFormat.percent(share.costUsd, of: report.costUsd)) of cost · \(UsageFormat.tokens(share.tokens)) tokens")
            : String(localized: "\(UsageFormat.percent(Double(share.tokens), of: Double(report.totals.processed))) of tokens · \(UsageFormat.usd(share.costUsd))"))
      }
    }
  }

  private func totalsSection(_ report: UsageReport) -> some View {
    Section("Totals") {
      LabeledContent("Processed tokens") {
        TechLabel(UsageFormat.tokens(report.totals.processed))
      }
      LabeledContent("Cache savings") { TechLabel(UsageFormat.usd(report.cacheSavingsUsd)) }
      LabeledContent {
        TechLabel(UsageFormat.tokens(report.totals.cachedInputTokens))
      } label: {
        SettingText("Cached input", "\(UsageFormat.percent(report.cachedShare, of: 1)) of observed input")
      }
      LabeledContent {
        TechLabel(UsageFormat.tokens(report.totals.uncachedInputTokens))
      } label: {
        SettingText("Uncached input", "\(UsageFormat.tokens(report.totals.cacheCreationTokens)) cache writes")
      }
      LabeledContent {
        TechLabel(UsageFormat.tokens(report.totals.outputTokens))
      } label: {
        SettingText(LocalizedStringResource("Output", comment: "output tokens"), "incl. \(UsageFormat.tokens(report.totals.reasoningTokens)) reasoning")
      }
      if report.unpricedRecords > 0 {
        LabeledContent {
          TechLabel(UsageFormat.percent(report.unpricedShare, of: 1))
        } label: {
          SettingText(LocalizedStringResource("Unpriced", comment: "share of usage records with no known price"), "of records, excluded from cost")
        }
      }
    }
  }

  private func modelsSection(_ report: UsageReport) -> some View {
    Section {
      ForEach(report.models.prefix(12)) { share in
        ShareRow(
          title: String(share.id.split(separator: "/", maxSplits: 1).last ?? Substring(share.id)), color: UsageFormat.color(share.provider),
          value: metric == .cost ? UsageFormat.usd(share.costUsd) : UsageFormat.tokens(share.tokens),
          detail: share.unpricedRecords == share.records && share.records > 0
            ? String(localized: "no known rates · \(UsageFormat.tokens(share.tokens)) tokens")
            : String(localized: "\(UsageReport.providerLabel(share.provider)) · \(UsageFormat.percent(Double(share.tokens), of: Double(report.totals.processed))) of tokens"))
      }
    } header: {
      Text("By model")
    } footer: {
      if !report.sourceProblems.isEmpty {
        Text(report.sourceProblems.joined(separator: "\n"))
      }
    }
  }

  // MARK: Loading

  private var notice: String? {
    if let failure { return failure }
    guard let computer else { return String(localized: "Connect an environment to see usage.") }
    if !computer.status.isConnected, report == nil { return String(localized: "Connect \(computer.label) to see its usage.") }
    if computer.grantedScopes != nil, !computer.holds(AuthScope.diagnosticsRead) {
      return String(localized: "This connection does not have permission to read usage on \(computer.label).")
    }
    return nil
  }

  private func load(fresh: Bool) async {
    guard let computer, computer.status.isConnected, !loading || fresh else { return }
    #if DEBUG
      if model.isSettingsFixture {
        report = UsageFixture.report(days: days)
        return
      }
    #endif
    loading = true
    defer { loading = false }
    do {
      let summary = try await model.registry.usageSummary(.window(days: days, fresh: fresh), in: computer.id)
      report = UsageReport(summary)
      failure = nil
    } catch {
      if report == nil { failure = ThreadSettingsPage.describe(error) }
    }
  }
}

/// Daily (or hourly) bars stacked by provider.
private struct UsageChart: View {
  let report: UsageReport
  let metric: UsageTab
  let hourly: Bool

  var body: some View {
    Chart(report.series) { point in
      BarMark(
        x: .value("Day", UsageFormat.date(point.key) ?? .now, unit: hourly ? .hour : .day),
        y: .value(metric == .cost ? "Cost" : "Tokens", metric == .cost ? point.costUsd : Double(point.tokens)))
        .foregroundStyle(by: .value("Provider", UsageReport.providerLabel(point.provider)))
    }
    .chartForegroundStyleScale(
      domain: report.providers.map { UsageReport.providerLabel($0.provider) },
      range: report.providers.map { UsageFormat.color($0.provider) })
    .chartLegend(.hidden)
    .chartYAxis {
      AxisMarks(position: .trailing) { value in
        AxisGridLine()
        AxisValueLabel {
          if let number = value.as(Double.self) {
            Text(metric == .cost ? UsageFormat.usdShort(number) : UsageFormat.tokens(Int(number)))
          }
        }
      }
    }
    .accessibilityLabel(Text(metric == .cost ? "Daily cost" : "Daily processed tokens"))
  }
}

private struct ShareRow: View {
  let title: String
  let color: Color
  let value: String
  let detail: String

  var body: some View {
    HStack(spacing: Spacing.md) {
      Circle().fill(color).frame(width: 9, height: 9).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(title).lineLimit(1)
        Text(detail)
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
      }
      Spacer(minLength: Spacing.sm)
      TechLabel(value)
    }
    .accessibilityElement(children: .combine)
  }
}

enum UsageFormat {
  static func usd(_ value: Double) -> String {
    value.formatted(.currency(code: "USD").precision(.fractionLength(value >= 1000 ? 0 : 2)))
  }

  static func usdShort(_ value: Double) -> String {
    value.formatted(.currency(code: "USD").notation(.compactName).precision(.significantDigits(1...3)))
  }

  static func tokens(_ value: Int) -> String {
    value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
  }

  static func percent(_ part: Double, of whole: Double) -> String {
    (whole == 0 ? 0 : part / whole).formatted(.percent.precision(.fractionLength(0)))
  }

  /// Usage kinds (`claude`) use the driver colors (`claudeAgent`).
  static func color(_ provider: String) -> Color {
    Palette.provider(provider == "claude" ? "claudeAgent" : provider) ?? Palette.meterFill
  }

  static func date(_ key: String) -> Date? {
    if key.count == 10 {
      var components = DateComponents()
      let parts = key.split(separator: "-").compactMap { Int($0) }
      guard parts.count == 3 else { return nil }
      components.year = parts[0]
      components.month = parts[1]
      components.day = parts[2]
      return Calendar.current.date(from: components)
    }
    return WireTimestamp(rawValue: key).date
  }
}

#if DEBUG
  /// Synthetic usage for the settings fixture: a month of Claude and Codex days.
  enum UsageFixture {
    static func report(days: Int) -> UsageReport {
      var buckets: [String] = []
      let calendar = Calendar.current
      for offset in 0..<min(days, 30) {
        let date = calendar.date(byAdding: .day, value: -offset, to: .now) ?? .now
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let day = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        let scale = Double((offset * 37) % 11 + 2)
        buckets.append(
          #"{"day":"\#(day)","provider":"claude","model":"claude-opus-5-5","totals":{"uncachedInputTokens":\#(Int(scale * 40_000)),"cachedInputTokens":\#(Int(scale * 900_000)),"cacheCreationTokens":\#(Int(scale * 60_000)),"outputTokens":\#(Int(scale * 30_000)),"reasoningTokens":\#(Int(scale * 8_000))},"costUsd":\#(scale * 3.1),"cacheSavingsUsd":\#(scale * 11),"records":\#(Int(scale) * 20),"unpricedRecords":0,"sessions":\#(Int(scale))}"#)
        if offset % 2 == 0 {
          buckets.append(
            #"{"day":"\#(day)","provider":"codex","model":"gpt-5.4","totals":{"uncachedInputTokens":\#(Int(scale * 20_000)),"cachedInputTokens":\#(Int(scale * 200_000)),"cacheCreationTokens":0,"outputTokens":\#(Int(scale * 12_000)),"reasoningTokens":\#(Int(scale * 4_000))},"costUsd":\#(scale * 0.9),"cacheSavingsUsd":\#(scale * 2),"records":\#(Int(scale) * 8),"unpricedRecords":0,"sessions":1}"#)
        }
      }
      let json = #"{"readAt":"","sinceDay":"2026-10-29","untilDay":"2026-11-27","buckets":[\#(buckets.joined(separator: ","))],"sources":[{"fingerprint":{"provider":"claude"},"status":"ok","distinctSessions":41}],"pricing":{"status":"fresh"}}"#
      return (try? JSONDecoder().decode(UsageSummary.self, from: Data(json.utf8))).map(UsageReport.init) ?? UsageReport()
    }
  }
#endif
