/** The uploader confirms participants agreed to be recorded; the API stores who and when. */
export function ConsentCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        I confirm that everyone in this recording agreed to be recorded.
        <span className="block text-xs text-muted-foreground">
          Your name and the time are stored with the recording.
        </span>
      </span>
    </label>
  );
}
