import AnkielKit
import SwiftUI

/// One usage window: label, percent left in mono, a capsule bar with the even-pace tick, then
/// pace and the reset countdown (RN `WindowRow`).
struct UsageWindowRow: View {
  let label: String
  /// 0…100.
  let remaining: Int
  var tint: Color?
  var paceRemaining: Int?
  var pace: LimitPace?
  var footer: String?

  private var barTint: Color { remaining <= 10 ? Palette.danger : (tint ?? Palette.meterFill) }

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.xs) {
      HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
        Text(label)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        TechLabel(String(localized: "\(remaining)% left"))
          .foregroundStyle(remaining <= 10 ? Palette.danger : Palette.textPrimary)
          .contentTransition(.numericText())
      }
      CapsuleMeter(value: Double(remaining), tint: barTint, tick: paceRemaining.map(Double.init))
        .padding(.vertical, Spacing.xxs)
      if pace != nil || footer != nil {
        HStack(spacing: Spacing.md) {
          if let pace { Text(UsageCopy.pace(pace)) }
          Spacer(minLength: 0)
          if let footer { TechLabel(footer, small: true) }
        }
        .font(Typography.caption)
        .foregroundStyle(Palette.textTertiary)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

extension UsageWindowRow {
  init(_ window: UsageWindow, driver: String, now: Date) {
    // A window whose reset already passed has no pace until the next reading.
    let current = window.resetsAt.map { $0 > now } ?? false
    self.init(
      label: window.label, remaining: UsageLimits.remainingPercent(window), tint: Palette.provider(driver),
      paceRemaining: current ? UsageLimits.paceRemainingPercent(window, now: now) : nil,
      pace: current ? UsageLimits.pace(window, now: now) : nil, footer: UsageCopy.reset(window, now: now))
  }
}

/// An account's name, plan and (hidden until tapped) email.
struct UsageAccountHeader: View {
  let account: LimitAccount
  @State private var revealed = false

  var body: some View {
    HStack(spacing: Spacing.sm) {
      Circle()
        .fill(Palette.provider(account.driver) ?? Palette.textTertiary)
        .frame(width: 8, height: 8)
      Text(UsageCopy.providerName(account.driver, displayName: account.displayName))
        .font(Typography.headline)
        .foregroundStyle(Palette.textPrimary)
        .lineLimit(1)
      if let plan = account.plan {
        Text(UsageLimits.shortPlanLabel(plan))
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      if account.displayName == nil, let email = account.email {
        Button(revealed ? email : UsageCopy.redactedEmail) { revealed.toggle() }
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
          .lineLimit(1)
          .frame(minHeight: 44)
          .contentShape(.rect)
          .buttonStyle(.plain)
          .accessibilityLabel(revealed ? String(localized: "Hide account email") : String(localized: "Reveal account email"))
      }
    }
  }
}

/// An account and its windows (the sheet's compact card, RN `CompactAccountCard`).
struct UsageAccountCard: View {
  let account: LimitAccount
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.md) {
      UsageAccountHeader(account: account)
      ForEach(account.limits.windows) { window in
        UsageWindowRow(window, driver: account.driver, now: now)
      }
      if let credits = account.limits.resetCredits, credits.availableCount > 0 {
        Text(UsageCopy.credits(credits, now: now))
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .padding(.vertical, Spacing.xs)
  }
}

/// The thread's context window: used and left, a meter, the token breakdown when the provider
/// reports one, and compaction (RN `ContextWindowCard`).
struct ContextWindowCard: View {
  let window: ContextWindowSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      HStack(alignment: .firstTextBaseline) {
        Text("Context window")
          .font(Typography.headline)
          .foregroundStyle(Palette.textPrimary)
        Spacer(minLength: Spacing.md)
        if let percent = window.level == .over ? window.maxTokens.map({ Int((Double(window.usedTokens) / Double($0) * 100).rounded()) }) : window.shownPercent {
          TechLabel(String(localized: "\(percent)% used"))
            .foregroundStyle(window.level == .normal ? Palette.textSecondary : window.tint)
            .contentTransition(.numericText())
        }
      }
      if let maxTokens = window.maxTokens, maxTokens > 0 {
        CapsuleMeter(value: window.usedPercentage ?? 0, tint: window.tint, height: 8)
        HStack {
          TechLabel(String(localized: "\(window.usedTokens.formatted()) of \(maxTokens.formatted()) tokens"), small: true)
          Spacer(minLength: Spacing.sm)
          TechLabel(String(localized: "\(ContextWindow.formatTokens(window.remainingTokens)) tokens left"), small: true)
        }
        .foregroundStyle(Palette.textTertiary)
      } else {
        TechLabel(String(localized: "\(ContextWindow.formatTokens(window.usedTokens)) tokens used"))
          .foregroundStyle(Palette.textSecondary)
      }
      if let status {
        Label(status, systemImage: statusSymbol)
          .font(Typography.footnote)
          .foregroundStyle(window.level == .normal ? Palette.textSecondary : window.tint)
      }
      if !breakdown.isEmpty {
        Grid(alignment: .leading, horizontalSpacing: Spacing.lg, verticalSpacing: Spacing.xxs) {
          ForEach(breakdown, id: \.0) { label, value in
            GridRow {
              Text(label).font(Typography.caption).foregroundStyle(Palette.textSecondary)
              TechLabel(ContextWindow.formatTokens(value), small: true)
                .foregroundStyle(Palette.textPrimary)
                .gridColumnAlignment(.trailing)
            }
          }
        }
        .padding(.top, Spacing.xxs)
      }
    }
    .padding(.vertical, Spacing.xs)
    .accessibilityElement(children: .combine)
  }

  private var breakdown: [(String, Int)] {
    [
      (String(localized: "Input", comment: "input tokens"), window.inputTokens),
      (String(localized: "Cache read"), window.cachedInputTokens),
      (String(localized: "Output", comment: "output tokens"), window.outputTokens),
      (String(localized: "Reasoning", comment: "reasoning tokens"), window.reasoningOutputTokens),
    ].compactMap { label, value in value.map { (label, $0) } }
  }

  private var statusSymbol: String {
    window.compacting ? "arrow.down.right.and.arrow.up.left" : window.level == .normal ? "checkmark.circle" : "exclamationmark.triangle"
  }

  private var status: String? {
    if window.compacting { return String(localized: "Compacting the conversation…") }
    switch window.level {
    case .over: return String(localized: "Over the context window. The agent compacts or drops older context on its next turn.")
    case .high: return String(localized: "Nearly full. The agent compacts older context automatically.")
    case .normal:
      if window.fromCompaction, let before = window.totalProcessedTokens {
        return String(localized: "Compacted from \(ContextWindow.formatTokens(before)) tokens")
      }
      return nil
    }
  }
}

/// Provider usage limits as a sheet: the thread's context window when opened from a thread, then
/// every connected account (RN `UsageLimitsSheet`).
struct UsageSheet: View {
  var context: ContextWindowSnapshot?
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      TimelineView(.everyMinute) { timeline in
        UsageLimitsList(context: context, now: timeline.date, compact: true)
      }
      .navigationTitle("Provider usage limits")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", systemImage: "xmark") { dismiss() }
            .accessibilityIdentifier("usage.done")
        }
        ToolbarItem(placement: .primaryAction) { UsageRefreshButton() }
      }
    }
    .task { await model.usage.refresher.refresh(model.usage.sources.map(\.environmentId), automatic: true) }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}

/// Refresh with a stepped spinner while it runs (no running animation of our own).
struct UsageRefreshButton: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if model.usage.isRefreshing {
      ProgressView()
    } else {
      Button("Refresh usage limits", systemImage: "arrow.clockwise") {
        Task { await model.usage.refresh() }
      }
      .accessibilityIdentifier("usage.refresh")
    }
  }
}

/// The shared body of the sheet and the Settings page. `compact` shows each account as a card;
/// otherwise accounts pool per provider with a page per account.
struct UsageLimitsList: View {
  var context: ContextWindowSnapshot?
  let now: Date
  var compact = false
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var openURL

  var body: some View {
    let sources = model.usage.sources
    let accounts = UsageLimits.accounts(sources)
    let notices = UsageLimits.notices(sources)
    let links = UsageLimits.externalLinks(sources)
    List {
      if let context {
        Section { ContextWindowCard(window: context) }
          .accessibilityIdentifier("usage.context")
      }
      if compact {
        ForEach(accounts) { account in
          Section { UsageAccountCard(account: account, now: now) }
        }
      } else {
        ForEach(UsageLimits.pools(accounts, now: now)) { pool in
          UsagePoolSection(pool: pool, now: now)
        }
      }
      if !links.isEmpty {
        Section {
          ForEach(links) { link in
            Button {
              if let url = URL(string: link.url) { openURL(url) }
            } label: {
              VStack(alignment: .leading, spacing: Spacing.xxs) {
                Label(link.label, systemImage: "arrow.up.right.square")
                  .foregroundStyle(Palette.accent)
                Text(link.accounts.map { String(localized: "\($0.provider) on \($0.environment)") }.joined(separator: ", "))
                  .font(Typography.caption)
                  .foregroundStyle(Palette.textTertiary)
              }
            }
          }
        } footer: {
          Text("Banked resets and plan details live on the provider's own usage page.")
        }
      }
      if !notices.isEmpty {
        Section {
          ForEach(Array(notices.enumerated()), id: \.offset) { _, entry in
            VStack(alignment: .leading, spacing: Spacing.xxs) {
              Text(entry.subject).font(Typography.subheadline).foregroundStyle(Palette.textPrimary)
              Text(UsageCopy.notice(entry.notice)).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
            }
          }
        }
      }
      if !model.usage.failedLabels.isEmpty {
        Section {
          Label(
            String(localized: "Could not refresh limits on \(model.usage.failedLabels.formatted(.list(type: .and))). Showing the last reading."),
            systemImage: "exclamationmark.triangle"
          )
          .font(Typography.footnote)
          .foregroundStyle(Palette.attention)
        }
      }
      if accounts.isEmpty, links.isEmpty, notices.isEmpty {
        Section {
          ContentUnavailableView {
            Label(sources.isEmpty ? "No connected computers" : "No provider limits reported.", systemImage: "gauge.with.dots.needle.0percent")
          } description: {
            Text(
              sources.isEmpty
                ? "Connect a computer to see its providers' usage limits."
                : "Signed-in Codex, Claude, Cursor and other subscriptions report their limits here.")
          }
        }
        .listRowBackground(Color.clear)
      }
    }
    .listSectionSpacing(.compact)
    // A sheet's inline bar needs no extra room above the first card.
    .contentMargins(.top, compact ? Spacing.sm : nil, for: .scrollContent)
    .refreshable { await model.usage.refresh() }
    .accessibilityIdentifier("usage.list")
  }
}

/// One provider's pooled windows, then its accounts (RN `UsageLimitsPooled`).
struct UsagePoolSection: View {
  let pool: LimitPool
  let now: Date

  var body: some View {
    Section {
      ForEach(UsageLimits.displayWindows(pool)) { window in
        let reset = window.resets.first
        UsageWindowRow(
          label: UsageLimits.cursorWindowIsUnlabeled(window.id, in: pool) ? String(localized: "Plan") : window.label,
          remaining: window.remainingPercent, tint: Palette.provider(pool.driver),
          paceRemaining: pool.accounts.count == 1 ? window.members.first.flatMap { UsageLimits.paceRemainingPercent($0.window, now: now) } : nil,
          pace: window.pace,
          footer: reset.map { pool.accounts.count > 1 ? UsageCopy.refill($0, now: now) : UsageCopy.reset($0.member.window, now: now) ?? "" })
      }
      ForEach(pool.accounts) { account in
        NavigationLink(value: SettingsRoute.usageAccount(account.key)) {
          UsageAccountHeader(account: account)
        }
        .accessibilityIdentifier("usage.account.\(account.key)")
      }
    } header: {
      Text(UsageCopy.providerName(pool.driver))
    } footer: {
      let oldest = pool.accounts.map(\.limits.checkedAt).min()
      if let oldest {
        Text(stale(oldest) ? String(localized: "\(UsageCopy.checked(oldest, now: now)). Pull to refresh.") : UsageCopy.checked(oldest, now: now))
          .foregroundStyle(stale(oldest) ? Palette.attention : Palette.textTertiary)
      }
    }
  }

  private func stale(_ date: Date) -> Bool { now.timeIntervalSince(date) > UsageWidgetSnapshot.maxAge }
}

/// Settings → Usage: every connected account's limits, pooled per provider.
struct UsageLimitsPage: View {
  var body: some View {
    TimelineView(.everyMinute) { timeline in
      UsageLimitsList(now: timeline.date)
    }
    .navigationTitle(Text("Usage", comment: "screen title"))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .primaryAction) { UsageRefreshButton() } }
  }
}

/// One account: where it signs in, its windows and its banked resets (RN `UsageLimitAccountScreen`).
struct UsageAccountPage: View {
  let key: String
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var openURL
  @State private var confirming = false
  @State private var redeeming = false
  @State private var status: String?

  var body: some View {
    TimelineView(.everyMinute) { timeline in
      let now = timeline.date
      if let account = UsageLimits.accounts(model.usage.sources).first(where: { $0.key == key }) {
        List {
          Section { UsageAccountHeader(account: account) }
          Section("Limits") {
            ForEach(account.limits.windows) { UsageWindowRow($0, driver: account.driver, now: now) }
          }
          Section {
            LabeledContent("Signed in", value: account.environments.map(\.label).formatted(.list(type: .and)))
            LabeledContent("Checked") { TechLabel(UsageCopy.checked(account.limits.checkedAt, now: now)) }
          }
          if let credits = account.limits.resetCredits {
            creditsSection(credits, account: account, now: now)
          }
          if let external = account.limits.externalUsage, let url = URL(string: external.url) {
            Section {
              Button("Manage usage", systemImage: "arrow.up.right.square") { openURL(url) }
            }
          }
        }
      } else {
        ContentUnavailableView(
          "This account is no longer reporting limits on the selected environments.", systemImage: "gauge.with.dots.needle.0percent")
      }
    }
    .navigationTitle(Text("Account", comment: "screen title"))
    .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private func creditsSection(_ credits: ResetCredits, account: LimitAccount, now: Date) -> some View {
    let canManage = model.registry.environment(account.redeem.environmentId)?.holds(AuthScope.providersManage) ?? false
    Section {
      Text(UsageCopy.credits(credits, now: now)).foregroundStyle(Palette.textPrimary)
      if credits.availableCount > 0 {
        Button(redeeming ? String(localized: "Using…", comment: "reset credit is being used") : String(localized: "Use reset")) {
          confirming = true
        }
        .disabled(redeeming || !canManage || model.usage.fixture != nil)
        .confirmationDialog("Use a reset credit?", isPresented: $confirming, titleVisibility: .visible) {
          Button("Use credit") { Task { await redeem(account) } }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.")
        }
      }
      if let status { Text(status).font(Typography.footnote).foregroundStyle(Palette.textSecondary) }
    } header: {
      Text("Reset credits")
    } footer: {
      if !canManage { Text("This connection cannot manage provider accounts.") }
    }
  }

  private func redeem(_ account: LimitAccount) async {
    redeeming = true
    status = nil
    do {
      let result = try await model.registry.consumeResetCredit(instanceId: account.redeem.instanceId, in: account.redeem.environmentId)
      status = UsageCopy.outcome(result)
      Haptics.success()
      await model.usage.refresher.refresh([account.redeem.environmentId])
    } catch {
      if case .rejected(let message?, _) = error { status = message } else { status = String(localized: "Could not use the reset credit.") }
    }
    redeeming = false
  }
}
