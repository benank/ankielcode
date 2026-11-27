import { Textarea, type TextareaProps } from "../ui/textarea";

/** A markdown textarea for issue and review comment text. */
export function PullRequestMarkdownTextarea({
  value,
  onValueChange,
  ...props
}: Omit<TextareaProps, "value" | "onChange"> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}) {
  return (
    <Textarea {...props} value={value} onChange={(event) => onValueChange(event.target.value)} />
  );
}
