import Foundation

/// Turning grouped entries into the feed's rows.
extension ThreadTimelineBuilder {
  static func messageRows(_ message: MessageEntry, foldId: String?, markdown: (String, String) -> MarkdownDocument, footer: Bool) -> [TimelineRow] {
    switch message.role {
    case .user:
      var fromAgent = false
      var freshContext = false
      if case .userMessage(let body) = message.row.item.body {
        fromAgent = body.createdBy == "agent" || body.senderThreadId != nil
        freshContext = body.freshContext == true
      }
      return [TimelineRow(
        id: message.id, content: .user(UserMessageRow(
          messageId: message.id, itemId: message.row.item.id, text: message.text, attachments: message.attachments,
          isSteer: message.isSteer, fromAgent: fromAgent, freshContext: freshContext, createdAt: message.createdAt,
          revision: message.row.item.revision)), foldId: foldId)]
    case .assistant:
      return [TimelineRow(
        id: message.id, content: .assistant(AssistantMessageRow(
          messageId: message.id, itemId: message.row.item.id, text: message.text, document: markdown(message.id, message.text),
          streaming: message.streaming, attachments: message.attachments, footer: footer ? message.updatedAt : nil,
          revision: message.row.item.revision)), foldId: foldId)]
    }
  }

  static func groupRows(
    _ group: GroupEntry, foldId: String?, failed: Bool, isWorking: Bool, activeRunId: String?, activeTail: Bool,
    subagents: [String: Subagent], markdown: (String, String) -> MarkdownDocument
  ) -> [TimelineRow] {
    guard let first = group.members.first else { return [] }
    switch first.item.body {
    case .compaction, .handoff, .notification:
      return [noticeRow(first, foldId: foldId)]
    case .userInputRequest(let request) where request.questionAnswer != nil:
      return [answeredRow(first, request: request, foldId: foldId)]
    case .subagent:
      return group.members.map { subagentRow($0, subagents: subagents, foldId: foldId) }
    default:
      break
    }
    if failed {
      // A failed turn keeps every call on its own row, so the failure reads in place.
      return group.members.flatMap { member in
        member.activity.prominent || isSevereError(member.item)
          ? [prominentRow(member, foldId: foldId, markdown: markdown)]
          : [TimelineRow(
            id: member.activity.id, content: .work(WorkRow(
              activity: member.activity, label: .activity(member.activity.label), live: false,
              inGroup: false)), foldId: foldId)]
      }
    }
    return activityGroupRows(
      group, foldId: foldId, isWorking: isWorking, activeRunId: activeRunId, activeTail: activeTail, markdown: markdown)
  }

  static func isSevereError(_ item: TurnItem) -> Bool {
    if case .error = item.body { item.status == .failed } else { false }
  }

  /// `appendActivityGroupRows`: prominent items get their own rows; runs of ordinary calls become
  /// a work group (or one lone row).
  static func activityGroupRows(
    _ group: GroupEntry, foldId: String?, isWorking: Bool, activeRunId: String?, activeTail: Bool,
    markdown: (String, String) -> MarkdownDocument
  ) -> [TimelineRow] {
    var anchors: [String: String] = [:]
    var anchor: String?
    for member in group.members {
      if member.activity.prominent || isSevereError(member.item) {
        anchor = nil
        continue
      }
      if anchor == nil { anchor = member.activity.id }
      anchors[member.activity.id] = anchor
    }
    let visible = group.members.filter { member in
      member.activity.isSettledVisible
        || (isWorking && member.activity.lifecycle == .inProgress && member.activity.runId == activeRunId)
    }
    var rows: [TimelineRow] = []
    var buffer: [ActivityEntry] = []
    func flush(trailing: Bool) {
      guard let head = buffer.first else { return }
      let groupId = "work-group:\(anchors[head.activity.id] ?? head.activity.id)"
      rows.append(contentsOf: toolGroupRows(
        buffer.map(\.activity), groupId: groupId, foldId: foldId, isWorking: isWorking, activeRunId: activeRunId,
        activeTail: activeTail && trailing))
      buffer = []
    }
    for member in visible {
      if !member.activity.prominent, !isSevereError(member.item), member.item.type != "notification" {
        buffer.append(member)
        continue
      }
      flush(trailing: false)
      rows.append(prominentRow(member, foldId: foldId, markdown: markdown))
    }
    flush(trailing: true)
    return rows
  }

  /// `appendToolGroupRows`.
  static func toolGroupRows(
    _ activities: [WorkActivity], groupId: String, foldId: String?, isWorking: Bool, activeRunId: String?, activeTail: Bool
  ) -> [TimelineRow] {
    guard let last = activities.last else { return [] }
    let latestActive = activities.last { isWorking && $0.lifecycle == .inProgress && $0.runId == activeRunId }
    let live = activeTail || latestActive != nil
    let latest = latestActive ?? last
    if activities.count == 1, !latest.isReasoning {
      let label: Display =
        if live {
          .activity(WorkActivity.liveLabel(latest))
        } else if latest.toolLike, latest.action == .edit {
          .summary(WorkSummary([latest]))
        } else {
          .activity(latest.label)
        }
      return [TimelineRow(
        id: latest.id, content: .work(WorkRow(activity: latest, label: label, live: latestActive != nil, inGroup: false)),
        foldId: foldId)]
    }
    let summary = WorkSummary(activities)
    let label: Display =
      if live {
        .activity(WorkActivity.liveLabel(latest))
      } else if activities.count == 1 {
        .activity(.thought(nil, live: false))
      } else {
        .summary(summary)
      }
    let lastToolLike = activities.last { $0.toolLike }
    var rows = [TimelineRow(
      id: "work-toggle:\(groupId)", content: .workGroup(WorkGroupRow(
        groupId: groupId, count: activities.count, label: label, kind: groupKind(activities, live: live, latest: latest),
        live: live, hasFailure: lastToolLike?.outcome == .failure)), foldId: foldId)]
    for activity in activities {
      rows.append(TimelineRow(
        id: "work-detail:\(activity.id)", content: .work(WorkRow(
          activity: activity, label: .activity(activity.label),
          live: isWorking && activity.id == latest.id && activity.lifecycle == .inProgress && activity.runId == activeRunId,
          inGroup: true)), foldId: foldId, groupId: groupId))
    }
    return rows
  }

  /// The group's icon: its one action's kind, else a generic tool mark (`toolGroupSummaryKind`).
  static func groupKind(_ activities: [WorkActivity], live: Bool, latest: WorkActivity) -> WorkKind {
    if live { return latest.kind }
    let tools = activities.filter { !$0.isReasoning }
    if tools.isEmpty { return .thinking }
    let kinds = Set(tools.map(\.kind))
    return kinds.count == 1 ? kinds.first! : .tool
  }

  static func prominentRow(
    _ member: ActivityEntry, foldId: String?, markdown: (String, String) -> MarkdownDocument
  ) -> TimelineRow {
    if case .proposedPlan(let plan) = member.item.body {
      return TimelineRow(
        id: member.activity.id, content: .plan(PlanRow(
          itemId: member.item.id, document: markdown("\(member.item.id)@\(member.item.revision)", plan.markdown),
          streaming: plan.streaming == true)),
        foldId: foldId)
    }
    return noticeRow(member, foldId: foldId)
  }

  static func noticeRow(_ member: ActivityEntry, foldId: String?) -> TimelineRow {
    let item = member.item
    var tone = NoticeRow.Tone.quiet
    var detail: String?
    var resetAt: WireTimestamp?
    switch item.body {
    case .error(let error):
      tone = error.failure.isUsageLimit ? .warning : .error
      detail = error.failure.message.nilIfEmpty
      resetAt = error.failure.resetAt
    case .systemNotice(let notice):
      tone = notice.level == "error" ? .error : notice.level == "warning" ? .warning : .quiet
    case .notification(let notification):
      detail = notification.detail?.nilIfEmpty
      tone = notification.outcome == "failed" ? .warning : .quiet
    case .secretRequest(let request):
      detail = request.reason.nilIfEmpty
    default:
      break
    }
    return TimelineRow(
      id: member.activity.id, content: .notice(NoticeRow(
        itemId: item.id, kind: member.activity.kind, label: member.activity.label, detail: detail, tone: tone,
        resetAt: resetAt)), foldId: foldId)
  }

  static func answeredRow(_ member: ActivityEntry, request: TurnItemBody.UserInputRequest, foldId: String?) -> TimelineRow {
    let answers = request.questionAnswer?["answers"]
    let pairs = request.questions.elements.map { question in
      let value = answers?[question.id]
      let answer: String? =
        switch value {
        case .string(let text)?: text
        case .array(let values)?: values.compactMap(\.stringValue).joined(separator: ", ").nilIfEmpty
        case .object(let object)?: object["answers"].flatMap { value in
          if case .array(let values) = value { values.compactMap(\.stringValue).joined(separator: ", ") } else { nil }
        }
        default: nil
        }
      return AnsweredRow.Pair(question: question.question, answer: answer)
    }
    return TimelineRow(id: member.activity.id, content: .answered(AnsweredRow(itemId: member.item.id, pairs: pairs)), foldId: foldId)
  }

  static func subagentRow(_ member: ActivityEntry, subagents: [String: Subagent], foldId: String?) -> TimelineRow {
    guard case .subagent(let call) = member.item.body else { return noticeRow(member, foldId: foldId) }
    let record = subagents[call.subagentId]
    let preview = (record?.result ?? call.result ?? record?.progress ?? call.progress ?? call.prompt)
      .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    return TimelineRow(
      id: member.activity.id, content: .subagent(SubagentRow(
        itemId: member.item.id, title: record?.title ?? member.item.title, status: member.item.status,
        childThreadId: call.childThreadId ?? record?.childThreadId, preview: preview.map { String($0.prefix(400)) },
        model: record?.model)), foldId: foldId)
  }
}
