import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@ankielcode/client-runtime/model-traits";
import { useAtomMount } from "@effect/atom-react";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useState } from "react";

import {
  ComposerModelControl,
  useComposerModelControlAccessibilityLabel,
} from "../../components/ComposerModelControl";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { providerWorkspaceSnapshotRefresh } from "../../state/provider-workspace-snapshot-refresh";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildComposerModelMenu } from "./composer-model-menu";
import type { ComposerModelPickerProps } from "./ComposerModelPicker.types";
import { useModelFavorites } from "./use-model-favorites";

/** JS cannot open a native menu, so `/model` opens the thread settings model list instead. */
export const COMPOSER_MODEL_COMMAND_OPENS_SETTINGS: boolean = true;

const MENU_STYLE = { minWidth: 0, flexShrink: 1 } as const;

function ModelPickerCatalogScan(props: Parameters<typeof providerWorkspaceSnapshotRefresh>[0]) {
  useAtomMount(providerWorkspaceSnapshotRefresh(props));
  return null;
}

/** A native menu for quick changes; "Thread settings" and "More models…" open the full sheet. */
export function ComposerModelPicker(props: ComposerModelPickerProps) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const favorites = useModelFavorites(props.environmentId);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const accessibilityLabel = useComposerModelControlAccessibilityLabel({
    modelOption: props.currentOption,
    selection: props.selection,
    provider: props.provider,
    reportedSelection: props.reportedSelection,
    prompt: props.prompt,
  });
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.currentOption?.capabilities,
    selections: props.selection.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const menu = buildComposerModelMenu({
    options: props.options,
    currentOption: props.currentOption,
    selection: props.selection,
    reportedSelection: props.reportedSelection,
    descriptors,
    ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
    favoriteKeys: favorites.loaded ? favorites.favoriteKeys : null,
    disabled: props.disabled,
    permissionsLabel: props.permissionsLabel,
    labels: {
      on: gt("On", { $context: "option state" }),
      off: gt("Off", { $context: "option state" }),
      ultrathink: "Ultrathink",
      fastMode: gt("Fast mode"),
      favorites: gt("Favorites", { $context: "section heading for favorite models" }),
      moreModels: gt("More models…"),
      runtime: gt("Runtime", { $context: "agent permission mode setting" }),
      threadSettings: gt("Thread settings"),
    },
  });

  const pressAction = (id: string) => {
    const intent = menu.intents.get(id);
    if (!intent) return;
    if (intent.kind === "settings") {
      props.onOpenSettings();
      return;
    }
    if (intent.kind === "runtime") {
      props.onOpenSettings("runtime");
      return;
    }
    if (intent.kind === "model") {
      const { selection } = intent.option;
      if (
        selection.instanceId === props.selection.instanceId &&
        selection.model === props.selection.model
      )
        return;
      void Haptics.selectionAsync();
      props.onSelectModel(intent.option);
      return;
    }
    const { descriptor, value } = intent;
    if (descriptor.type === "select" && typeof value === "string") {
      if (
        promptTraits.ultrathinkInBodyText &&
        descriptor.id === promptTraits.primarySelectDescriptor?.id
      ) {
        Dialog.alert(
          gt("Reasoning controlled by prompt"),
          gt('Your prompt contains "ultrathink" in the text. Remove it to change this option.'),
        );
        return;
      }
      const change = getTraitSelectChange(
        { ...promptTraits, descriptors },
        descriptor,
        props.prompt,
        value,
      );
      if (!change) return;
      void Haptics.selectionAsync();
      props.onChangeOptions(change.modelOptions ?? [], change.prompt);
      return;
    }
    const options = applyProviderOptionSelection(descriptors, { id: descriptor.id, value });
    if (!options) return;
    void Haptics.selectionAsync();
    props.onChangeOptions(options, props.prompt);
  };

  return (
    <>
      {open && props.cwd ? (
        <ModelPickerCatalogScan
          environmentId={props.environmentId}
          instanceId={props.selection.instanceId}
          cwd={props.cwd}
        />
      ) : null}
      <Menu
        accessible
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        // Keeps the expanded label's truncation chain intact through the native wrapper.
        style={MENU_STYLE}
        actions={menu.actions}
        onOpenMenu={() => {
          setOpen(true);
          if (props.canRefreshCatalog) {
            void refreshProviders({
              environmentId: props.environmentId,
              input: { modelCatalogOnly: true },
            });
          }
        }}
        onCloseMenu={() => setOpen(false)}
        onPressAction={({ nativeEvent }) => pressAction(nativeEvent.event)}
      >
        <ComposerModelControl
          size={props.size}
          modelOption={props.currentOption}
          selection={props.selection}
          provider={props.provider}
          reportedSelection={props.reportedSelection}
          prompt={props.prompt}
          surfaceColor={props.surfaceColor}
          iconOnly={props.iconOnly}
        />
      </Menu>
    </>
  );
}
