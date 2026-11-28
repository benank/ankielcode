import AnkielKit
import SwiftUI
import UIKit

/// Project grouping and language (RN `SettingsProjectGroupingRouteScreen`, the General page).
struct GeneralSettingsPage: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var openURL

  private static let options: [(ProjectGroupingMode, LocalizedStringResource, LocalizedStringResource)] = [
    (.repository, "Group by repository", "Matching repositories appear as one project."),
    (.repositoryPath, "Group by repository path", "Keep monorepo paths separate."),
    (.separate, "Keep separate", "Show every workspace as its own project."),
  ]

  var body: some View {
    @Bindable var preferences = model.preferences
    ThemedList {
      Section {
        // iOS keeps the per-app language in the app's page in Settings; it relaunches the app.
        Button {
          if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        } label: {
          LabeledContent {
            HStack(spacing: Spacing.xs) {
              Text(Self.currentLanguage)
              Image(systemName: "arrow.up.forward")
                .font(Typography.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            }
          } label: {
            Text("Language")
          }
        }
        .tint(.primary)
        .accessibilityHint(Text("Opens Ankiel Code in the Settings app"))
        .accessibilityIdentifier("general.language")
      } footer: {
        Text("Choose the app's language in its page in the Settings app.")
      }

      Section {
        ChoiceRows(selection: $preferences.values.projectGroupingMode, options: Self.options)
      } header: {
        Text("Project grouping")
      } footer: {
        Text("How the project filter on the thread list combines the same project across computers.")
      }
    }
    .navigationTitle("General")
    .navigationBarTitleDisplayMode(.inline)
    .onChange(of: model.preferences.values.projectGroupingMode) { _, _ in model.home.groupingChanged() }
  }

  /// The language the app is showing, in that language ("Deutsch", "日本語").
  private static var currentLanguage: String {
    let code = Bundle.main.preferredLocalizations.first ?? "en"
    return Locale(identifier: code).localizedString(forIdentifier: code)?.localizedCapitalized ?? code
  }
}

/// Theme and code text (RN `SettingsAppearanceRouteScreen`). Text size follows Dynamic Type.
struct AppearanceSettingsPage: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var preferences = model.preferences
    ThemedList {
      Section("Color scheme") {
        Picker(selection: $preferences.values.themeMode) {
          Text("System", comment: "appearance follows the system").tag(ThemeMode.system)
          Text("Light", comment: "light appearance").tag(ThemeMode.light)
          Text("Dark", comment: "dark appearance").tag(ThemeMode.dark)
        } label: {
          Text("Theme")
        }
        .pickerStyle(.segmented)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
        .accessibilityIdentifier("appearance.theme")
      }

      Section("Themes") {
        ThemeGrid(light: $preferences.values.lightThemeId, dark: $preferences.values.darkThemeId)
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
      }

      Section {
        CodePreview()
        Toggle("Custom font size", isOn: customCodeSize)
          .accessibilityIdentifier("appearance.customCodeSize")
        if let size = preferences.values.codeFontSize {
          Stepper(value: codeSize(default: size), in: ClientPreferenceValues.codeFontSizes, step: 1) {
            LabeledContent("Font size") {
              Text("\(Int(size)) pt")
                .monospacedDigit()
                .contentTransition(.numericText(value: size))
            }
          }
        }
        Toggle("Word break", isOn: $preferences.values.codeWordBreak)
      } header: {
        Text("Code and diffs")
      } footer: {
        Text("Word break wraps long lines instead of scrolling them sideways.")
      }
      .motion(Motion.microSlow, value: preferences.values.codeFontSize == nil)

      Section {
      } header: {
        Text("Text", comment: "settings section for text size")
      } footer: {
        Text("Ankiel Code follows the text size you choose for your device in Display & Brightness, including the larger accessibility sizes.")
      }
    }
    .navigationTitle("Appearance")
    .navigationBarTitleDisplayMode(.inline)
    .sensoryFeedback(.selection, trigger: preferences.values.themeMode)
    .sensoryFeedback(.selection, trigger: [preferences.values.lightThemeId, preferences.values.darkThemeId])
  }

  private var customCodeSize: Binding<Bool> {
    Binding(
      get: { model.preferences.values.codeFontSize != nil },
      set: { model.preferences.values.codeFontSize = $0 ? ClientPreferenceValues.defaultCodeFontSize : nil })
  }

  private func codeSize(default size: Double) -> Binding<Double> {
    Binding(get: { model.preferences.values.codeFontSize ?? size }, set: { model.preferences.values.codeFontSize = $0 })
  }
}

/// The color themes (RN `ThemeAppearanceSection`): a card per theme with its light and dark
/// swatches. The card sets both appearances; a swatch sets only its own.
private struct ThemeGrid: View {
  @Binding var light: String?
  @Binding var dark: String?

  var body: some View {
    let selection = ThemeSelection(lightId: light, darkId: dark)
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Spacing.md)], spacing: Spacing.md) {
      ForEach(ThemeID.allCases, id: \.self) { theme in
        ThemeCard(
          theme: theme, lightSelected: selection.light == theme, darkSelected: selection.dark == theme,
          select: { appearance in
            if appearance != true { light = theme.rawValue }
            if appearance != false { dark = theme.rawValue }
          })
      }
    }
    .motion(Motion.micro, value: selection)
  }
}

private struct ThemeCard: View {
  let theme: ThemeID
  let lightSelected: Bool
  let darkSelected: Bool
  /// Whether it sets the dark appearance (false: light); nil sets both.
  let select: (_ dark: Bool?) -> Void

  var body: some View {
    VStack(spacing: Spacing.xs) {
      HStack(spacing: Spacing.sm) {
        swatch(dark: false, selected: lightSelected)
        swatch(dark: true, selected: darkSelected)
      }
      Button {
        select(nil)
      } label: {
        Text(Self.name(theme))
          .font(Typography.callout.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .frame(maxWidth: .infinity, minHeight: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text("\(Self.name(theme)) theme"))
      .accessibilityHint(Text("Sets both light and dark appearances"))
      .accessibilityAddTraits(lightSelected && darkSelected ? .isSelected : [])
      .accessibilityIdentifier("appearance.theme.\(theme.rawValue)")
    }
    .padding(.top, Spacing.lg)
    .padding(.bottom, Spacing.xs)
    .padding(.horizontal, Spacing.sm)
    .frame(maxWidth: .infinity)
    .background(Palette.groupedRow, in: .rect(cornerRadius: Radius.large, style: .continuous))
    .contentShape(.rect(cornerRadius: Radius.large, style: .continuous))
    .onTapGesture { select(nil) }
  }

  private func swatch(dark: Bool, selected: Bool) -> some View {
    Button {
      select(dark)
    } label: {
      ThemeSwatch(theme: theme, dark: dark, size: 52)
        .padding(3)
        .overlay { Circle().strokeBorder(selected ? Palette.accent : .clear, lineWidth: 2.5) }
        .overlay(alignment: .bottomTrailing) {
          if selected {
            Image(systemName: dark ? "moon" : "sun.max")
              .font(Typography.caption2.weight(.medium))
              .foregroundStyle(Palette.textSecondary)
              .frame(width: 20, height: 20)
              .background(Palette.surface, in: .circle)
              .overlay { Circle().strokeBorder(Palette.border) }
              .transition(.scale.combined(with: .opacity))
          }
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(
      dark ? Text("\(Self.name(theme)) dark theme") : Text("\(Self.name(theme)) light theme"))
    .accessibilityHint(dark ? Text("Sets the dark appearance only") : Text("Sets the light appearance only"))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("appearance.theme.\(theme.rawValue).\(dark ? "dark" : "light")")
  }

  /// RN translates the newer theme names; "Ankiel Code" and "Orchid" are names, not words.
  static func name(_ theme: ThemeID) -> String {
    switch theme {
    case .grove: String(localized: "Grove", comment: "color theme name")
    case .ocean: String(localized: "Ocean", comment: "color theme name")
    case .ember: String(localized: "Ember", comment: "color theme name")
    case .iris: String(localized: "Iris", comment: "color theme name")
    case .ankielCode, .orchid: theme.label
    }
  }
}

/// A short highlighted snippet in the current code settings.
private struct CodePreview: View {
  @Environment(\.codeAppearance) private var appearance

  var body: some View {
    if let code = Self.block {
      CodeBlockView(code: code)
        .environment(\.codeAppearance, appearance)
        .listRowInsets(EdgeInsets(top: Spacing.md, leading: Spacing.md, bottom: Spacing.md, trailing: Spacing.md))
        .accessibilityHidden(true)
    }
  }

  @MainActor static let block: CodeBlock? = {
    let source = """
      ```swift
      let tide = await station.reading(at: .midnight)
      guard tide.height > threshold else { return .calm }  // harbor stays open
      ```
      """
    for block in MarkdownParser(style: .thread).parse(source).blocks {
      if case .code(let code) = block.kind { return code }
    }
    return nil
  }()
}

/// What a message sent while the agent works does (RN `SettingsFollowUpRouteScreen`).
struct ChatSettingsPage: View {
  @Environment(AppModel.self) private var model

  private static let options: [(FollowUpBehavior, LocalizedStringResource, LocalizedStringResource)] = [
    (.steer, LocalizedStringResource("Steer", comment: "verb, follow-up behavior"), "Your message reaches the agent right away, changing what it is working on."),
    (.queue, LocalizedStringResource("Queue", comment: "verb, follow-up behavior"), "Your message waits and runs after the current turn finishes."),
  ]

  var body: some View {
    @Bindable var preferences = model.preferences
    ThemedList {
      Section {
        ChoiceRows(selection: $preferences.values.followUpBehavior, options: Self.options)
      } header: {
        Text("While the agent is running")
      } footer: {
        Text("The other choice stays one tap away, in the small button beside Send.")
      }

      Section {
        Toggle(isOn: $preferences.values.streamHapticsEnabled) {
          Text("Streaming replies", comment: "haptics setting")
        }
        .accessibilityIdentifier("chat.streamHaptics")
      } header: {
        Text("Haptics")
      } footer: {
        Text("A light tap while the agent’s reply streams in, in the thread you are looking at.")
      }
    }
    .navigationTitle("Chat")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// Mutually exclusive choices with a description each, a checkmark on the chosen one.
struct ChoiceRows<Value: Hashable>: View {
  @Binding var selection: Value
  let options: [(Value, LocalizedStringResource, LocalizedStringResource)]

  var body: some View {
    ForEach(options, id: \.0) { value, title, detail in
      Button {
        selection = value
      } label: {
        HStack(spacing: Spacing.md) {
          VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(title).foregroundStyle(Palette.textPrimary)
            Text(detail)
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
          }
          Spacer(minLength: Spacing.sm)
          Image(systemName: "checkmark")
            .font(Typography.body.weight(.semibold))
            .foregroundStyle(Palette.accent)
            .opacity(selection == value ? 1 : 0)
            .accessibilityHidden(true)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityAddTraits(selection == value ? .isSelected : [])
      .sensoryFeedback(.selection, trigger: selection)
    }
    .motion(Motion.microFast, value: selection)
  }
}
