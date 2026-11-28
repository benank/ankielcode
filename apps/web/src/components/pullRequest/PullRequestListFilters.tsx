import { Spinner } from "~/components/ui/spinner";
import type { EnvironmentId, ProjectId } from "@ankielcode/contracts";
import { SearchIcon } from "lucide-react";
import { useGT } from "gt-react";
import { type ElementType, useState } from "react";

import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PullRequestFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly Icon: ElementType<{ className?: string }>;
  readonly project?: ProjectFaviconProject;
  readonly unavailable?: string | undefined;
}

export function PullRequestFilterOptionIcon<Value extends string>({
  option,
}: {
  option: PullRequestFilterOption<Value>;
}) {
  return option.project ? (
    <ProjectFavicon project={option.project} className="size-3.5" />
  ) : (
    <option.Icon aria-hidden className="size-3.5" />
  );
}

export function PullRequestSearchInput({
  value,
  busy,
  label,
  placeholder,
  onChange,
  onSubmit,
}: {
  value: string;
  busy?: boolean;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
      <InputGroupAddon>
        {busy ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
      </InputGroupAddon>
      {/* Native search inputs clear on Escape even during IME composition. */}
      <InputGroupInput
        type="text"
        role="searchbox"
        value={draft ?? value}
        onFocus={() => setDraft(value)}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          onChange(event.currentTarget.value);
          if ((event.nativeEvent as InputEvent).inputType === "insertFromPaste") {
            onSubmit(event.currentTarget.value);
          }
        }}
        onKeyDown={(event) => {
          const composing = event.nativeEvent.isComposing || event.keyCode === 229;
          if (event.key === "Enter" && !composing) onSubmit(event.currentTarget.value);
          if (event.key !== "Escape" || event.defaultPrevented) return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (!composing && !event.currentTarget.value) return;
          // The list page leaves on an Escape that reaches it.
          event.stopPropagation();
          if (composing) return;
          setDraft("");
          onChange("");
        }}
        placeholder={placeholder}
        aria-label={label}
      />
    </InputGroup>
  );
}

/** Project ids are unique only within an environment. */
export const pullRequestProjectKey = (project: {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}) => JSON.stringify([project.environmentId, project.id]);

function PullRequestFilterRadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  const gt = useGT();
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next as Value);
      }}
    >
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map((option) => {
        const item = (
          <MenuRadioItem
            key={option.value}
            value={option.value}
            className={option.unavailable ? "data-disabled:pointer-events-auto" : undefined}
            disabled={option.unavailable !== undefined}
          >
            <span className="flex min-w-0 items-center gap-2">
              <PullRequestFilterOptionIcon option={option} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.unavailable ? (
                <span className="shrink-0">
                  · {gt("Unavailable", { $context: "filter option" })}
                </span>
              ) : null}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        );
        if (!option.unavailable) return item;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={item} />
            <TooltipPopup side="top">{option.unavailable}</TooltipPopup>
          </Tooltip>
        );
      })}
    </MenuRadioGroup>
  );
}

export function PullRequestFilterRadioSubmenu<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <PullRequestFilterOptionIcon option={current} />
        <span className="flex-1">{label}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {current.label}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestFilterRadioGroup
          label={label}
          value={value}
          options={options}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}
