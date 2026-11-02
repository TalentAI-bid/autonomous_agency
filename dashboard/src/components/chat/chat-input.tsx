'use client';

import { useState, useRef, useCallback, type KeyboardEvent, type DragEvent } from 'react';
import { cn } from '@/lib/utils';
import { Paperclip, ArrowUp, X, FileText } from 'lucide-react';

interface ChatInputProps {
  onSend: (content: string, files?: File[]) => void;
  disabled: boolean;
}

const ACCEPTED_TYPES = '.pdf,.docx,.csv,.xlsx,.xls';
const ACCEPTED_EXTS = ['pdf', 'docx', 'csv', 'xlsx', 'xls'];

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  function handleSend() {
    const trimmed = content.trim();
    if (!trimmed && files.length === 0) return;
    onSend(trimmed, files.length > 0 ? files : undefined);
    setContent('');
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleFileSelect(selectedFiles: FileList | null) {
    if (!selectedFiles) return;
    const newFiles = Array.from(selectedFiles).filter((f) => {
      const ext = f.name.toLowerCase().split('.').pop() ?? '';
      return ACCEPTED_EXTS.includes(ext);
    });
    setFiles((prev) => [...prev, ...newFiles]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  }

  const canSend = !disabled && (content.trim().length > 0 || files.length > 0);

  return (
    <div className="border-t border-line px-4 pb-3 pt-3" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragging && (
        <div className="mb-3 rounded-lg border-2 border-dashed border-accent-mid bg-accent-tint p-4 text-center text-body text-accent-fg">
          Drop a document (PDF/DOCX) or a company list (CSV/XLSX) here
        </div>
      )}

      <div
        className={cn(
          'rounded-xl border bg-bg-panel transition-colors focus-within:border-accent-mid focus-within:ring-2 focus-within:ring-accent-weak',
          disabled ? 'border-line opacity-70' : 'border-line-strong',
        )}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {files.map((file, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-md bg-bg-soft py-1 pl-2 pr-1 text-xs text-ink-2">
                <FileText size={12} className="text-ink-3" />
                <span className="max-w-40 truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  aria-label={`Remove ${file.name}`}
                  className="rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5 p-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="Attach a file"
            title="Attach a document or company list"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-bg-soft hover:text-ink disabled:opacity-50"
          >
            <Paperclip size={16} />
          </button>
          <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} multiple className="hidden" onChange={(e) => handleFileSelect(e.target.files)} />

          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Describe who you want to reach…"
            rows={1}
            disabled={disabled}
            className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-body text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="Send"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>

      <p className="mb-0 mt-2 px-1 text-xs text-ink-4">Enter to send · Shift+Enter for a new line · attach a PDF, DOCX, CSV or XLSX</p>
    </div>
  );
}
