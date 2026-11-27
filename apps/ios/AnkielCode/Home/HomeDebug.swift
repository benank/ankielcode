#if DEBUG
  import AnkielKit
  import Foundation

  /// `ANKIEL_DEBUG_HOME`: presets the thread list with canned rows (display only; actions on them
  /// fail as not connected). Documented in `apps/ios/README.md`.
  extension HomeModel {
    func debugPreset(_ name: String) {
      switch name {
      case "empty":
        debugSources = [ThreadListSource(environmentId: "debug-env", label: "Studio Mac", threads: [], projects: [Self.debugProject("p1", "ankielcode")])]
      case "sample":
        debugSources = Self.sampleSources()
      default:
        return
      }
      observeSources()
      setEnvironmentFilter(nil)
      setProjectFilter(nil)
    }

    private static func debugProject(_ id: String, _ title: String) -> ProjectShell {
      let json = #"{"id":"\#(id)","title":"\#(title)","workspaceRoot":"/src/\#(title)","defaultModelSelection":null,"scripts":[],"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z"}"#
      return try! JSONDecoder().decode(ProjectShell.self, from: Data(json.utf8))
    }

    private static func debugThread(
      _ id: String, _ title: String, project: String, minutesAgo: Double, configure: (inout [String: Any]) -> Void = { _ in }
    ) -> ThreadShell {
      let at = WireTimestamp(Date.now.addingTimeInterval(-minutesAgo * 60)).rawValue
      var object: [String: Any] = [
        "createdBy": "user", "creationSource": "mobile", "id": id, "projectId": project, "title": title,
        "providerInstanceId": "claudeAgent", "modelSelection": ["instanceId": "claudeAgent", "model": "claude-opus-5-5"],
        "runtimeMode": "full-access", "interactionMode": "default", "branch": NSNull(), "worktreePath": NSNull(),
        "lineage": ["parentThreadId": NSNull(), "relationshipToParent": NSNull(), "rootThreadId": id],
        "forkedFrom": NSNull(), "activeProviderThreadId": NSNull(), "latestRunId": "run-\(id)", "activeRunId": NSNull(),
        "status": "completed", "pendingRuntimeRequest": NSNull(), "latestVisibleMessage": NSNull(),
        "latestUserMessageAt": at, "latestRunRequestedAt": at, "latestRunCompletedAt": at, "lastVisitedAt": at,
        "hasActionableProposedPlan": false, "itemCount": 4, "visibleItemCount": 4, "createdAt": at, "updatedAt": at,
        "archivedAt": NSNull(), "settledOverride": NSNull(), "settledAt": NSNull(), "deletedAt": NSNull(),
      ]
      configure(&object)
      let data = try! JSONSerialization.data(withJSONObject: object)
      return try! JSONDecoder().decode(ThreadShell.self, from: data)
    }

    private static func sampleSources() -> [ThreadListSource] {
      let earlier = { (minutes: Double) in WireTimestamp(Date.now.addingTimeInterval(-minutes * 60)).rawValue }
      let later = { (minutes: Double) in WireTimestamp(Date.now.addingTimeInterval(minutes * 60)).rawValue }
      let studio = [
        debugThread("pinned", "Release checklist for 0.2", project: "p1", minutesAgo: 600) {
          $0["pinnedAt"] = earlier(500)
          $0["pinOrderKey"] = "n"
        },
        debugThread("approval", "Migrate the settings store", project: "p1", minutesAgo: 3) {
          $0["status"] = "running"
          $0["activeRunId"] = "run-approval"
          $0["activityRunStatus"] = "running"
          $0["pendingRuntimeRequest"] = ["id": "r1", "kind": "command", "createdAt": earlier(1)]
        },
        debugThread("working", "Fix flaky shell reducer test", project: "p1", minutesAgo: 1) {
          $0["status"] = "running"
          $0["activeRunId"] = "run-working"
          $0["activityRunStatus"] = "running"
          $0["latestRunCompletedAt"] = NSNull()
        },
        debugThread("subagent", "Subagent: /root/work/scan_logs", project: "p1", minutesAgo: 1) {
          $0["lineage"] = ["parentThreadId": "working", "relationshipToParent": "subagent", "rootThreadId": "working"]
          $0["status"] = "running"
          $0["activityRunStatus"] = "running"
        },
        debugThread("done", "Add the iPad split layout", project: "p1", minutesAgo: 25) {
          $0["lastVisitedAt"] = earlier(60)
          // A synthetic linked pull request, for the row's chip.
          $0["pullRequests"] = [
            [
              "host": "github.com", "repository": "tidewater/tide-chart", "number": 128,
              "url": "https://github.com/tidewater/tide-chart/pull/128", "source": "agent", "linkedAt": earlier(90),
              "stack": NSNull(),
              "snapshot": [
                "state": "open", "title": "Cache the last tide table for offline use", "headBranch": "offline-tables",
                "baseBranch": "main", "isDraft": false, "updatedAt": earlier(30), "syncedAt": earlier(5), "checksState": "passing",
              ],
            ]
          ]
        },
        debugThread("input", "Pick a name for the new command", project: "p2", minutesAgo: 8) {
          $0["pendingRuntimeRequest"] = ["id": "r2", "kind": "user_input", "createdAt": earlier(8)]
        },
        debugThread("failed", "Deploy the marketing site", project: "p2", minutesAgo: 42) {
          $0["status"] = "failed"
          $0["lastVisitedAt"] = earlier(120)
        },
        debugThread("read", "Tidy the onboarding copy", project: "p2", minutesAgo: 180),
        debugThread("snoozed", "Follow up on the relay latency", project: "p1", minutesAgo: 300) {
          $0["snoozedUntil"] = later(150)
          $0["snoozedAt"] = earlier(60)
        },
        debugThread("settled-1", "Wire the pairing QR scanner", project: "p1", minutesAgo: 1500) {
          $0["settledOverride"] = "settled"
          $0["settledAt"] = earlier(1400)
        },
        debugThread("settled-2", "Investigate disk usage", project: "p2", minutesAgo: 3000) {
          $0["settledOverride"] = "settled"
          $0["settledAt"] = earlier(2900)
        },
      ]
      let linux = [
        debugThread("gpu", "Train the tokenizer on the new corpus", project: "p3", minutesAgo: 12) {
          $0["status"] = "running"
          $0["activeRunId"] = "run-gpu"
          $0["activityRunStatus"] = "running"
        }
      ]
      return [
        ThreadListSource(
          environmentId: "debug-studio", label: "Studio Mac", threads: studio,
          projects: [debugProject("p1", "ankielcode"), debugProject("p2", "ankiel.com")]),
        ThreadListSource(environmentId: "debug-linux", label: "Linux box", threads: linux, projects: [debugProject("p3", "ml")]),
      ]
    }
  }
#endif
