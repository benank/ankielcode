export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  /**
   * `sheet` suits a short confirm of an action the user just started. iPhone shows an action
   * sheet; iPad, regular-width windows and Android keep the alert, since nothing anchors the sheet.
   */
  readonly presentation?: "alert" | "sheet";
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
};

export type TextInputDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly placeholder?: string;
  readonly initialValue: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly onConfirm: (value: string) => void;
  readonly onCancel?: () => void;
};
