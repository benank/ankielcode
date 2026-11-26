import type {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionSelection,
} from "@ankielcode/contracts";

import type { ModelOption } from "../../lib/modelOptions";

export type ComposerModelPickerPage = "thinking" | "models";

export type ComposerModelPickerProps = {
  /** The Android overlay's open page. iOS presents a native menu, which JS cannot open. */
  readonly page: ComposerModelPickerPage | null;
  readonly onPageChange: (page: ComposerModelPickerPage | null) => void;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly canRefreshCatalog: boolean;
  readonly options: ReadonlyArray<ModelOption>;
  readonly currentOption: ModelOption | null;
  readonly selection: ModelSelection;
  readonly provider: ProviderDriverKind | undefined;
  readonly reportedSelection?: ModelSelection | null;
  readonly prompt: string;
  readonly surfaceColor: string;
  readonly size: "regular" | "large";
  readonly iconOnly: boolean;
  readonly disabled: boolean;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly onChangeOptions: (
    options: ReadonlyArray<ProviderOptionSelection>,
    prompt: string,
  ) => void;
  readonly permissionsLabel: string | undefined;
  readonly onOpenSettings: (page?: "runtime") => void;
};
