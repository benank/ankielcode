import AnkielKit
import SwiftUI

/// RN `CustomSnoozeSheet`: snooze until a date and time, or for a duration.
struct CustomSnoozeSheet: View {
  let snooze: (Date) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var mode = Mode.date
  @State private var date = Date.now.addingTimeInterval(3600)
  @State private var amount = 2
  @State private var unit = CustomSnooze.Unit.hours
  @State private var error: String?

  enum Mode: Hashable { case date, duration }

  var body: some View {
    NavigationStack {
      Form {
        Picker("Snooze mode", selection: $mode) {
          Text("Date and time").tag(Mode.date)
          Text("Duration").tag(Mode.duration)
        }
        .pickerStyle(.segmented)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
        .accessibilityIdentifier("customSnooze.mode")
        switch mode {
        case .date:
          DatePicker("Snooze until", selection: $date, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
            .accessibilityIdentifier("customSnooze.date")
        case .duration:
          HStack(spacing: 0) {
            Picker("Duration amount", selection: $amount) {
              ForEach(1...99, id: \.self) { Text(verbatim: "\($0)").tag($0) }
            }
            .accessibilityIdentifier("customSnooze.amount")
            Picker("Duration unit", selection: $unit) {
              Text("Minutes").tag(CustomSnooze.Unit.minutes)
              Text("Hours").tag(CustomSnooze.Unit.hours)
              Text("Days").tag(CustomSnooze.Unit.days)
            }
            .accessibilityIdentifier("customSnooze.unit")
          }
          .pickerStyle(.wheel)
          .labelsHidden()
        }
        if let error {
          Text(error)
            .font(Typography.footnote)
            .foregroundStyle(Palette.danger)
        }
      }
      .navigationTitle("Custom snooze")
      .navigationBarTitleDisplayMode(.inline)
      .onChange(of: mode) { _, _ in error = nil }
      .onChange(of: date) { _, _ in error = nil }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark") { dismiss() }
            .accessibilityLabel(Text("Cancel custom snooze"))
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            submit()
          } label: {
            Text("Snooze", comment: "verb, confirm button")
          }
          .accessibilityIdentifier("customSnooze.confirm")
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func submit() {
    let input: CustomSnooze = mode == .date ? .date(date) : .duration(amount, unit)
    guard let wake = input.wake(now: .now) else {
      error = mode == .date ? String(localized: "Choose a date and time in the future.") : String(localized: "Enter a positive duration.")
      return
    }
    snooze(wake)
    dismiss()
  }
}

/// Presents the custom snooze sheet for whichever row asked (`HomeModel.customSnoozeRow`), from the
/// list's menus and the thread screen's alike.
struct CustomSnoozeHost: ViewModifier {
  @Environment(AppModel.self) private var model

  func body(content: Content) -> some View {
    let home = model.home
    content.sheet(item: Binding(get: { home.customSnoozeRow }, set: { home.customSnoozeRow = $0 })) { row in
      CustomSnoozeSheet { wake in
        Haptics.success()
        home.snooze(row, until: wake)
      }
    }
  }
}
