import AnkielKit
import SwiftUI

/// One run, read top to bottom (RN `WorkflowRunRouteScreen`): what waits on you, each step and
/// what its agent said, how it ended; answer, resume or cancel with `orchestration:operate`.
struct WorkflowRunScreen: View {
  let route: WorkflowRunRoute
  let workflows: WorkflowsModel
  let openRun: (WorkflowRunRoute) -> Void
  let openThread: (ThreadRef) -> Void
  @State private var run: WorkflowRunModel?
  @State private var confirmingCancel = false
  @State private var failure: String?
  @State private var feedback = 0

  private var snapshot: WorkflowRunsSnapshot? { workflows.snapshot(route.environmentId) }

  private var node: WorkflowRunNode? {
    guard let snapshot else { return nil }
    return Workflows.group(workflows: snapshot.workflows, runs: snapshot.runs, questions: snapshot.questions).node(route.runId)
  }

  private var refreshKey: String { workflows.refreshKey(route.runId, environmentId: route.environmentId) }

  var body: some View {
    Group {
      if let node {
        body(node)
      } else if snapshot == nil {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ContentUnavailableView(
          "This run is not in the list", systemImage: "questionmark.circle",
          description: Text("It may be older than the runs this server still lists."))
      }
    }
    .background(Palette.canvas)
    .navigationTitle(node?.run.workflow ?? String(localized: "Run", comment: "noun, page title for one workflow run"))
    .navigationBarTitleDisplayMode(.inline)
    .task(id: refreshKey) {
      if run == nil { run = WorkflowRunModel(environmentId: route.environmentId, runId: route.runId, source: workflows.source) }
      await run?.load()
    }
    .alert("Cancel this run?", isPresented: $confirmingCancel) {
      Button("Keep it", role: .cancel) {}
      Button("Cancel run", role: .destructive) { act(.cancel, failed: String(localized: "Could not cancel the run")) }
    } message: {
      Text("Its agents stop and the run cannot be resumed.")
    }
    .alert(failure ?? "", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
      Button("OK", role: .cancel) {}
    }
    .sensoryFeedback(.success, trigger: feedback)
  }

  private var canOperate: Bool { workflows.canOperate(route.environmentId) }

  private func body(_ node: WorkflowRunNode) -> some View {
    let steps = run?.detail?.steps
    let children = snapshot?.runs.filter { $0.parentRunId == route.runId } ?? []
    let feed = steps.map { Workflows.feed(Workflows.timeline(run: node.run, steps: $0, children: children, now: .now)) }
    let pausedAt = feed.flatMap { Workflows.pausedBeat($0, status: node.run.status) }
    return ScrollView {
      VStack(alignment: .leading, spacing: Spacing.md) {
        header(node)
        ForEach(node.questions, id: \.name) { question in questionCard(question) }
        if node.run.status == .paused { pauseCard(node.run, at: pausedAt) }
        if let feed {
          if !feed.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(feed) { row in
                feedRow(row, pausedAt: pausedAt)
                if row.id != feed.last?.id { Divider().padding(.leading, 44) }
              }
            }
            .background(Palette.surface, in: .rect(cornerRadius: Radius.large, style: .continuous))
          }
        } else {
          Text(run?.error ?? String(localized: "Loading the run's steps…"))
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textSecondary)
        }
        if node.run.status == .completed { result(node.run) }
        if !node.run.hasEnded, canOperate {
          Button("Cancel run", role: .destructive) { confirmingCancel = true }
            .frame(maxWidth: .infinity, minHeight: 44)
            .disabled(run?.busy != nil)
            .accessibilityIdentifier("workflow.cancel")
        }
      }
      .padding(Spacing.lg)
      .frame(maxWidth: Layout.readingWidth)
      .frame(maxWidth: .infinity)
    }
  }

  private func header(_ node: WorkflowRunNode) -> some View {
    VStack(alignment: .leading, spacing: Spacing.xs) {
      HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
        Text(node.run.title)
          .font(Typography.title)
          .frame(maxWidth: .infinity, alignment: .leading)
        WorkflowStateWord(state: Workflows.state(node), large: true)
      }
      HStack(spacing: Spacing.sm) {
        WorkflowChip(name: node.run.workflow)
        Text("\(node.run.workflow) · started \(WorkflowCopy.relative(node.run.startedAt))")
          .font(Typography.caption)
          .foregroundStyle(Palette.textSecondary)
      }
    }
    .accessibilityElement(children: .combine)
  }

  // MARK: Cards

  private func card(@ViewBuilder _ content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: Spacing.sm, content: content)
      .padding(Spacing.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.surface, in: .rect(cornerRadius: Radius.large, style: .continuous))
  }

  private func questionCard(_ question: WorkflowQuestion) -> some View {
    let view = Workflows.read(question)
    return card {
      HStack(spacing: Spacing.sm) {
        Circle().fill(Palette.attention).frame(width: 7, height: 7).accessibilityHidden(true)
        Text("Needs you", comment: "workflow run status: it waits on a person")
          .font(Typography.subheadline.weight(.medium))
        Text("asked \(WorkflowCopy.relative(question.askedAt))")
          .font(Typography.caption)
          .foregroundStyle(Palette.textSecondary)
      }
      Text(view.title).font(Typography.body.weight(.semibold))
      if let body = view.body {
        Text(body.replacing(/\*\*|__|`/, with: "")).font(Typography.subheadline).foregroundStyle(Palette.textSecondary)
      }
      VStack(spacing: Spacing.sm) {
        ForEach(Array(view.choices.enumerated()), id: \.element) { index, choice in
          let busy = run?.busy == WorkflowRunModel.Action.answer(name: question.name, choice: choice).key
          Button {
            act(.answer(name: question.name, choice: choice), failed: String(localized: "Could not send the answer"))
          } label: {
            HStack {
              if busy { ProgressView() }
              Text(choice).frame(maxWidth: .infinity)
            }
            .frame(minHeight: 32)
          }
          .modifier(ChoiceStyle(primary: index == 0))
          .disabled(!canOperate || (run?.busy != nil && !busy))
          .accessibilityIdentifier("workflow.choice")
        }
        if let thread = question.thread {
          Button("Ask the agent first") {
            openThread(ThreadRef(environmentId: thread.environmentId ?? route.environmentId, threadId: thread.threadId))
          }
          .font(Typography.subheadline)
          .frame(minHeight: 44)
        }
      }
      .padding(.top, Spacing.xs)
      if !canOperate {
        Text("This connection can read runs but not answer them.")
          .font(Typography.caption)
          .foregroundStyle(Palette.textSecondary)
      }
    }
  }

  private func pauseCard(_ run: WorkflowRun, at beat: WorkflowBeat?) -> some View {
    card {
      Label {
        Text("Paused", comment: "workflow run status").font(Typography.subheadline.weight(.medium))
      } icon: {
        Image(systemName: "exclamationmark.circle").foregroundStyle(Palette.danger)
      }
      Text(run.detail ?? String(localized: "A step failed.")).font(Typography.subheadline)
      Text(
        run.retired
          ? String(localized: "It cannot go on until its workflow version is registered again.")
          : run.resumesAt == nil
            ? String(localized: "It waits for you to resume it.") : String(localized: "It tries again by itself, or resume it now.")
      )
      .font(Typography.caption)
      .foregroundStyle(Palette.textSecondary)
      Button {
        act(.resume, failed: String(localized: "Could not resume the run"))
      } label: {
        HStack {
          if self.run?.busy == WorkflowRunModel.Action.resume.key { ProgressView() }
          Text("Resume now").frame(maxWidth: .infinity)
        }
        .frame(minHeight: 32)
      }
      .modifier(ChoiceStyle(primary: true))
      .disabled(self.run?.busy != nil || !canOperate || run.retired)
      .accessibilityIdentifier("workflow.resume")
    }
  }

  private func result(_ run: WorkflowRun) -> some View {
    let lines = Workflows.resultLines(run.result)
    return VStack(alignment: .leading, spacing: Spacing.sm) {
      ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
        if let label = line.label {
          HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(Palette.textSecondary)
            Text(line.value).fontWeight(.medium)
          }
          .font(Typography.footnote)
        } else {
          Text(line.value).font(Typography.subheadline)
        }
      }
    }
    .padding(.horizontal, Spacing.xs)
  }

  // MARK: Steps

  @ViewBuilder
  private func feedRow(_ row: WorkflowFeedRow, pausedAt: WorkflowBeat?) -> some View {
    switch row {
    case .quick(let quick):
      StepLine(
        symbol: "checkmark", tint: Palette.textTertiary,
        title: quick.steps.count == 1 ? quick.steps[0].name : String(localized: "\(quick.steps.count) quick steps"),
        detail: quick.steps.count > 1 ? quick.steps.map(\.name).joined(separator: ", ") : nil,
        time: Workflows.stepTime(quick.endMs - quick.startMs))
    case .beat(let beat):
      beatRow(beat, paused: beat == pausedAt)
    case .together(let beats):
      VStack(alignment: .leading, spacing: 0) {
        Text("At the same time")
          .font(Typography.caption.weight(.medium))
          .foregroundStyle(Palette.textSecondary)
          .padding(.horizontal, Spacing.lg)
          .padding(.top, Spacing.sm)
        ForEach(beats) { beat in beatRow(beat, paused: beat == pausedAt) }
      }
    }
  }

  private func beatRow(_ beat: WorkflowBeat, paused: Bool) -> some View {
    let summary = Workflows.agentSummary(result: beat.result, said: beat.said)
    let answer = beat.kind == .ask ? Workflows.answer(beat.result) : nil
    let detail: String? =
      if beat.status == .failed { beat.detail } else if let answer { answer.reason.map { "\(answer.choice) · \($0)" } ?? answer.choice } else {
        summary.said.map(Workflows.oneLine)
      }
    return VStack(alignment: .leading, spacing: Spacing.xs) {
      StepLine(
        symbol: Self.symbol(beat), tint: beat.status == .failed ? Palette.danger : beat.status == .running ? Palette.working : Palette.textSecondary,
        title: beat.childRun?.title ?? beat.name, detail: detail, time: Workflows.stepTime(beat.endMs - beat.startMs),
        emphasized: paused)
      if !summary.facts.isEmpty, beat.kind == .agent {
        Text(summary.facts.map { "\($0.label) \($0.value)" }.joined(separator: " · "))
          .font(Typography.caption)
          .foregroundStyle(Palette.textSecondary)
          .padding(.leading, 44)
          .padding(.trailing, Spacing.lg)
      }
      HStack(spacing: Spacing.md) {
        if let threadId = beat.threadId {
          Button("Open thread", systemImage: "bubble.left.and.text.bubble.right") {
            openThread(ThreadRef(environmentId: beat.threadEnvironmentId ?? route.environmentId, threadId: threadId))
          }
          .accessibilityIdentifier("workflow.thread")
        }
        if let child = beat.childRun {
          Button("Open run", systemImage: "arrow.turn.down.right") {
            openRun(WorkflowRunRoute(environmentId: route.environmentId, runId: child.runId))
          }
        }
      }
      .font(Typography.footnote)
      .padding(.leading, 44)
      .padding(.bottom, beat.threadId != nil || beat.childRun != nil ? Spacing.sm : 0)
    }
  }

  private static func symbol(_ beat: WorkflowBeat) -> String {
    if beat.status == .failed { return "exclamationmark.circle" }
    switch beat.kind {
    case .agent: return "sparkles"
    case .ask: return "questionmark.bubble"
    case .sleep: return "moon.zzz"
    case .wait: return "hourglass"
    case .run: return "point.3.connected.trianglepath.dotted"
    case .step, .unknown: return beat.status == .running ? "circle.dotted" : "checkmark"
    }
  }

  private func act(_ action: WorkflowRunModel.Action, failed: String) {
    guard let run else { return }
    Task {
      if let error = await run.perform(action) {
        failure = "\(failed): \(error)"
      } else {
        feedback += 1
      }
    }
  }
}

private struct ChoiceStyle: ViewModifier {
  let primary: Bool
  func body(content: Content) -> some View {
    if primary {
      content.buttonStyle(.glassProminent).tint(Palette.primaryButton).foregroundStyle(Palette.onPrimaryButton)
    } else {
      content.buttonStyle(.glass)
    }
  }
}

/// One line of a run's flow: what it was, how it went, how long it took.
private struct StepLine: View {
  let symbol: String
  let tint: Color
  let title: String
  let detail: String?
  let time: String
  var emphasized = false

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
      Image(systemName: symbol)
        .font(Typography.footnote.weight(.semibold))
        .foregroundStyle(tint)
        .frame(width: 20)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(Typography.subheadline.weight(emphasized ? .semibold : .medium))
          .foregroundStyle(Palette.textPrimary)
        if let detail, !detail.isEmpty {
          Text(detail)
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .lineLimit(3)
        }
      }
      Spacer(minLength: Spacing.sm)
      Text(time)
        .font(Typography.caption.monospacedDigit())
        .foregroundStyle(Palette.textTertiary)
    }
    .padding(.horizontal, Spacing.lg)
    .padding(.vertical, Spacing.md)
    .accessibilityElement(children: .combine)
  }
}
