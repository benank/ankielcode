import type { ProjectScript, ResolvedKeybindingsConfig } from "@ankielcode/contracts";
import { T, useGT } from "gt-react";
import { SettingsIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../../keybindings";
import { commandForProjectScript } from "../../projectScripts";
import { ScriptIcon } from "../projectScriptEditor";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function ProjectActionsList({
  scripts,
  keybindings,
  disabled,
  onEdit,
}: {
  scripts: readonly ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  disabled: boolean;
  onEdit: (script: ProjectScript) => void;
}) {
  const gt = useGT();
  if (scripts.length === 0)
    return (
      <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
        <T>No actions configured.</T>
      </p>
    );
  return scripts.map((script) => {
    const shortcutLabel = shortcutLabelForCommand(keybindings, commandForProjectScript(script.id));
    return (
      <SettingsRow
        key={script.id}
        className="group py-2"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <ScriptIcon icon={script.icon} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{script.name}</span>
            {script.runOnWorktreeCreate ? (
              <Badge variant="outline" size="sm">
                {gt("setup", { $context: "badge, action runs when a worktree is created" })}
              </Badge>
            ) : null}
            {script.runOnSettle ? (
              <Badge variant="outline" size="sm">
                <T>on settle</T>
              </Badge>
            ) : null}
            {script.previewUrl ? (
              <Badge variant="outline" size="sm" className="max-sm:hidden">
                <T>preview · desktop only</T>
              </Badge>
            ) : null}
          </span>
        }
        description={<code className="block max-w-full truncate font-mono">{script.command}</code>}
        control={
          <>
            {shortcutLabel ? (
              <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
            ) : null}
            <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Edit {name}", { name: script.name })}
                disabled={disabled}
                onClick={() => onEdit(script)}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </span>
          </>
        }
      />
    );
  });
}
