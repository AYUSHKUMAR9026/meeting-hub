'use client';

import { uploadAcceptAttribute } from '@meeting-hub/contracts/upload-rules';
import { FileAudioIcon, UploadIcon, XIcon } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/upload/progress';
import { checkRecordingFile } from '@/lib/upload/validate';

export interface SelectedRecording {
  file: File;
  contentType: string;
}

/**
 * Drag-and-drop (or click-to-browse) picker for one recording. Wrong types and oversized files are
 * rejected here with a clear message, before anything is uploaded.
 */
export function FileDropZone({
  value,
  onChange,
  disabled,
}: {
  value: SelectedRecording | null;
  onChange: (value: SelectedRecording | null) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const check = checkRecordingFile(file);
    if (!check.ok) {
      setError(check.error);
      onChange(null);
      return;
    }
    setError(null);
    onChange({ file, contentType: check.contentType });
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (!disabled) pick(e.dataTransfer.files);
  }

  if (value) {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border px-3 py-2"
        data-testid="selected-file"
      >
        <FileAudioIcon className="size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{value.file.name}</p>
          <p className="text-xs text-muted-foreground">{formatBytes(value.file.size)}</p>
        </div>
        {!disabled && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove file"
            onClick={() => onChange(null)}
          >
            <XIcon />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm transition-colors ${dragging ? 'border-primary bg-muted' : ''} ${disabled ? 'opacity-50' : ''}`}
      >
        <UploadIcon className="size-6 text-muted-foreground" />
        <p>
          Drag a recording here, or{' '}
          <label
            htmlFor={inputId}
            className="cursor-pointer font-medium underline underline-offset-4"
          >
            choose a file
          </label>
        </p>
        <p className="text-xs text-muted-foreground">
          MP3, M4A, AAC, WAV, OGG, Opus, WebM, MP4 or MOV · up to 2 GB
        </p>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept={uploadAcceptAttribute}
          className="sr-only"
          aria-label="Recording file"
          disabled={disabled}
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
