import AnkielKit
import SwiftUI

/// The list filter (`home-list-filter-menu.ts`): one computer or all, and one project group or
/// all. The choice persists.
struct FilterMenu: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let home = model.home
    let environments = home.environmentChoices
    Menu {
      if environments.count > 1 {
        Picker(selection: environmentSelection) {
          Text("All computers").tag(String?.none)
          ForEach(environments, id: \.id) { environment in
            Text(environment.label).tag(Optional(environment.id))
          }
        } label: {
          Text("Computer", comment: "filter menu heading")
        }
        .pickerStyle(.inline)
      }
      if !home.projectChoices.isEmpty {
        Picker(selection: projectSelection) {
          Text("All projects").tag(String?.none)
          ForEach(home.projectChoices) { scope in
            Text(scope.title ?? String(localized: "No project")).tag(Optional(scope.key))
          }
        } label: {
          Text("Project", comment: "filter menu heading")
        }
        .pickerStyle(.inline)
      }
    } label: {
      Label(
        "Filter",
        systemImage: home.isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
    }
    .accessibilityIdentifier("home.filter")
    .accessibilityValue(home.isFiltered ? Text("Filtered") : Text("All threads"))
  }

  private var environmentSelection: Binding<String?> {
    Binding(get: { model.home.environmentFilterResolved }, set: { model.home.setEnvironmentFilter($0) })
  }

  private var projectSelection: Binding<String?> {
    Binding(get: { model.home.projectFilter?.key }, set: { model.home.setProjectFilter($0) })
  }
}

/// Home with no threads to list (`home-empty-state.ts`).
struct HomeEmptyState: View {
  let environments: [EnvironmentModel]
  let newThread: () -> Void
  let computers: () -> Void

  private enum Kind { case connecting, unavailable(String?), noProjects, noThreads }

  private var kind: Kind {
    let held = environments.filter { $0.shell.snapshot != nil }
    if held.isEmpty {
      let trying = environments.contains {
        switch $0.status {
        case .connecting, .connected, .reconnecting: true
        default: false
        }
      }
      if trying { return .connecting }
      return .unavailable(environments.first.map { ConnectionPresentation.statusText($0.status, host: $0.label) })
    }
    if held.allSatisfy({ $0.shell.projects.isEmpty }) { return .noProjects }
    return .noThreads
  }

  var body: some View {
    switch kind {
    case .connecting:
      ContentUnavailableView {
        Label("Connecting to environment", systemImage: "desktopcomputer")
      } description: {
        Text("Loading projects and threads from the saved environment.")
      } actions: {
        ProgressView()
      }
    case .unavailable(let reason):
      ContentUnavailableView {
        Label("Environment unavailable", systemImage: "bolt.horizontal.circle")
      } description: {
        Text(reason ?? String(localized: "This computer is offline. Check its address or start it, then try again."))
      } actions: {
        Button("Computers", action: computers)
          .buttonStyle(.glass)
      }
    case .noProjects:
      ContentUnavailableView(
        "No projects found", systemImage: "folder",
        description: Text("The connected environment did not report any projects."))
    case .noThreads:
      ContentUnavailableView {
        Label("No threads yet", systemImage: "bubble.left.and.text.bubble.right")
      } description: {
        Text("Create a task to start a new coding runtime in one of your connected projects.")
      } actions: {
        Button(action: newThread) {
          Text("New thread").foregroundStyle(Palette.onAccent)
        }
        .buttonStyle(.glassProminent)
      }
    }
  }
}
