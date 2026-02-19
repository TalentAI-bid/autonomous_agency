'use client';

import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, File } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UploadZoneProps {
  onFilesAdded: (files: File[]) => void;
  accept?: Record<string, string[]>;
  maxFiles?: number;
  disabled?: boolean;
}

export function UploadZone({ onFilesAdded, accept, maxFiles = 10, disabled }: UploadZoneProps) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted.length > 0) onFilesAdded(accepted);
    },
    [onFilesAdded],
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept,
    maxFiles,
    disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={cn(
        'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
        isDragActive && !isDragReject && 'border-primary bg-primary/5',
        isDragReject && 'border-destructive bg-destructive/5',
        !isDragActive && 'border-border hover:border-border/80 hover:bg-muted/30',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-3">
        {isDragActive ? (
          <File className="w-8 h-8 text-primary" />
        ) : (
          <Upload className="w-8 h-8 text-muted-foreground" />
        )}
        <div>
          <p className="text-sm font-medium">
            {isDragActive ? 'Drop files here...' : 'Drag & drop files here'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            or <span className="text-primary cursor-pointer">click to browse</span>
          </p>
          {accept && (
            <p className="text-xs text-muted-foreground mt-1">
              Supported: {Object.values(accept).flat().join(', ')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
