import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  platform: { OS: "ios", isPad: false },
  metrics: null as { readonly horizontalSizeClass: "compact" | "regular" } | null,
  alert: vi.fn(),
  showActionSheetWithOptions: vi.fn(),
  impactAsync: vi.fn(async () => {}),
}));

vi.mock("react-native", () => ({
  Alert: { alert: native.alert },
  ActionSheetIOS: { showActionSheetWithOptions: native.showActionSheetWithOptions },
  Platform: native.platform,
}));
vi.mock("expo-haptics", () => ({
  impactAsync: native.impactAsync,
  ImpactFeedbackStyle: { Medium: "medium" },
}));
vi.mock("../../native/native-layout-metrics-snapshot", () => ({
  currentNativeLayoutMetrics: () => native.metrics,
}));

import * as Dialog from "./Dialog";

type SheetCall = [
  {
    readonly title?: string;
    readonly message?: string;
    readonly options: readonly string[];
    readonly destructiveButtonIndex?: number;
    readonly cancelButtonIndex?: number;
  },
  (index: number) => void,
];

function request(overrides: Partial<Dialog.ConfirmDialogRequest> = {}) {
  return {
    title: "Delete thread?",
    message: "“Fix login” will be permanently deleted.",
    confirmText: "Delete",
    destructive: true,
    presentation: "sheet",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  } satisfies Dialog.ConfirmDialogRequest;
}

function lastSheet() {
  return native.showActionSheetWithOptions.mock.lastCall as SheetCall;
}

beforeEach(() => {
  native.platform.OS = "ios";
  native.platform.isPad = false;
  native.metrics = null;
  native.alert.mockReset();
  native.showActionSheetWithOptions.mockReset();
  native.impactAsync.mockClear();
});

describe("Dialog.confirm on iOS", () => {
  it("shows a sheet confirm as an action sheet on iPhone", () => {
    const confirm = request();
    Dialog.confirm(confirm);

    expect(native.alert).not.toHaveBeenCalled();
    expect(lastSheet()[0]).toEqual({
      title: "Delete thread?",
      message: "“Fix login” will be permanently deleted.",
      options: ["Delete", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });

    lastSheet()[1](0);
    expect(confirm.onConfirm).toHaveBeenCalledOnce();
    expect(confirm.onCancel).not.toHaveBeenCalled();
    expect(native.impactAsync).toHaveBeenCalledWith("medium");
  });

  it("treats the sheet's cancel button and outside taps as a cancel", () => {
    const confirm = request({ cancelText: "Keep editing" });
    Dialog.confirm(confirm);

    expect(lastSheet()[0].options).toEqual(["Delete", "Keep editing"]);
    lastSheet()[1](1);
    expect(confirm.onCancel).toHaveBeenCalledOnce();
    expect(confirm.onConfirm).not.toHaveBeenCalled();
    expect(native.impactAsync).not.toHaveBeenCalled();
  });

  it("marks no destructive button for a non-destructive sheet", () => {
    const confirm = request({ destructive: false });
    Dialog.confirm(confirm);

    expect(lastSheet()[0].destructiveButtonIndex).toBeUndefined();
    lastSheet()[1](0);
    expect(confirm.onConfirm).toHaveBeenCalledOnce();
    expect(native.impactAsync).not.toHaveBeenCalled();
  });

  it.each([
    { where: "on iPad", isPad: true, sizeClass: null },
    { where: "on iPad in a compact window", isPad: true, sizeClass: "compact" as const },
    { where: "in a regular-width phone window", isPad: false, sizeClass: "regular" as const },
  ])("falls back to an alert $where, where nothing anchors the sheet", ({ isPad, sizeClass }) => {
    native.platform.isPad = isPad;
    native.metrics = sizeClass ? { horizontalSizeClass: sizeClass } : null;
    Dialog.confirm(request());

    expect(native.showActionSheetWithOptions).not.toHaveBeenCalled();
    expect(native.alert).toHaveBeenCalledOnce();
  });

  it("shows an alert unless the caller asks for a sheet", () => {
    const confirm = request({ presentation: undefined });
    Dialog.confirm(confirm);

    expect(native.showActionSheetWithOptions).not.toHaveBeenCalled();
    const [title, message, buttons] = native.alert.mock.lastCall as [
      string,
      string,
      { text: string; style: string; onPress?: () => void }[],
    ];
    expect([title, message]).toEqual([
      "Delete thread?",
      "“Fix login” will be permanently deleted.",
    ]);
    expect(buttons.map(({ text, style }) => [text, style])).toEqual([
      ["Cancel", "cancel"],
      ["Delete", "destructive"],
    ]);

    buttons[1]!.onPress?.();
    expect(confirm.onConfirm).toHaveBeenCalledOnce();
    expect(native.impactAsync).toHaveBeenCalledWith("medium");
  });
});
