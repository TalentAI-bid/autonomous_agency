'use client';

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectProps {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  /** Called with a change-event-shaped object, so `e.target.value` keeps working. */
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  required?: boolean;
  title?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Optional second line under an option's label, keyed by option value. */
  hints?: Record<string, string>;
  /** Extra classes for the open list, e.g. `w-72` to make it wider than the trigger. */
  menuClassName?: string;
  /** Which edge of the trigger the open list lines up with. */
  menuAlign?: 'left' | 'right';
  /** `<option>` elements, optionally wrapped in fragments or produced by `.map()`. */
  children?: React.ReactNode;
}

interface Opt {
  value: string;
  label: string;
  disabled: boolean;
}

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children);
  return '';
}

function collect(children: React.ReactNode, out: Opt[]) {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as { value?: string | number; disabled?: boolean; children?: React.ReactNode };
    if (child.type === React.Fragment) return collect(props.children, out);
    if (child.type !== 'option') return;
    const label = textOf(props.children);
    out.push({ value: props.value != null ? String(props.value) : label, label, disabled: Boolean(props.disabled) });
  });
}

/**
 * Drop-in replacement for a native `<select>`: same `<option>` children, `value` and `onChange`,
 * but with a styled trigger and list. Size/width overrides go through className (applied to the
 * trigger); add `w-full` to make it fill its container.
 */
const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    { id, name, value, defaultValue, onChange, disabled, title, className, hints, menuClassName, menuAlign = 'left', children, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy },
    ref,
  ) => {
    const options: Opt[] = [];
    collect(children, options);

    const [inner, setInner] = React.useState(defaultValue ?? options[0]?.value ?? '');
    const current = value ?? inner;
    const selected = options.find((o) => o.value === current);
    const isEmpty = !selected || selected.value === '';

    const [open, setOpen] = React.useState(false);
    const [dropUp, setDropUp] = React.useState(false);
    const [highlight, setHighlight] = React.useState(-1);
    const wrapRef = React.useRef<HTMLDivElement>(null);
    const listRef = React.useRef<HTMLUListElement>(null);
    const listId = React.useId();

    const enabledIdx = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

    function openMenu() {
      if (disabled) return;
      const idx = options.findIndex((o) => o.value === current);
      setHighlight(idx >= 0 ? idx : (enabledIdx[0] ?? -1));
      const rect = wrapRef.current?.getBoundingClientRect();
      if (rect) {
        const menuH = Math.min(options.length * 36 + 12, 268);
        setDropUp(window.innerHeight - rect.bottom < menuH + 8 && rect.top > menuH + 8);
      }
      setOpen(true);
    }

    function choose(i: number) {
      const o = options[i];
      if (!o || o.disabled) return;
      setOpen(false);
      if (o.value === current) return;
      if (value === undefined) setInner(o.value);
      onChange?.({ target: { value: o.value, name }, currentTarget: { value: o.value, name } } as unknown as React.ChangeEvent<HTMLSelectElement>);
    }

    React.useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    React.useEffect(() => {
      if (!open || highlight < 0) return;
      listRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' });
    }, [open, highlight]);

    function move(dir: 1 | -1) {
      if (enabledIdx.length === 0) return;
      const pos = enabledIdx.indexOf(highlight);
      const next = pos < 0 ? (dir === 1 ? 0 : enabledIdx.length - 1) : (pos + dir + enabledIdx.length) % enabledIdx.length;
      setHighlight(enabledIdx[next]);
    }

    function onKeyDown(e: React.KeyboardEvent) {
      if (disabled) return;
      if (!open) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
          e.preventDefault();
          openMenu();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // don't also close a surrounding dialog
        setOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setHighlight(enabledIdx[0] ?? -1);
      } else if (e.key === 'End') {
        e.preventDefault();
        setHighlight(enabledIdx[enabledIdx.length - 1] ?? -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose(highlight);
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    }

    return (
      <div ref={wrapRef} className={cn('relative inline-flex max-w-full', /(^|\s)w-full(\s|$)/.test(className ?? '') && 'w-full')}>
        <button
          ref={ref}
          type="button"
          id={id}
          title={title}
          disabled={disabled}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={onKeyDown}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg-panel px-3 text-left text-body transition-colors hover:border-line-strong focus-visible:border-accent-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak disabled:cursor-not-allowed disabled:bg-bg-soft disabled:text-ink-4 disabled:hover:border-line',
            isEmpty ? 'text-ink-3' : 'text-ink',
            open && 'border-accent-mid ring-2 ring-accent-weak',
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{selected ? selected.label : ''}</span>
          <ChevronDown size={14} className={cn('shrink-0 text-ink-4 transition-transform', open && 'rotate-180')} />
        </button>

        {name && <input type="hidden" name={name} value={current} />}

        {open && (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            className={cn(
              'scroll-thin absolute z-50 m-0 max-h-[268px] min-w-full list-none overflow-auto rounded-xl border border-line bg-bg-panel p-1 shadow-lg',
              menuAlign === 'right' ? 'right-0' : 'left-0',
              dropUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
              menuClassName,
            )}
          >
            {options.map((o, i) => {
              const active = o.value === current;
              return (
                <li
                  key={`${o.value}-${i}`}
                  role="option"
                  aria-selected={active}
                  aria-disabled={o.disabled || undefined}
                  onMouseEnter={() => !o.disabled && setHighlight(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                  className={cn(
                    'flex cursor-pointer gap-2 rounded-lg px-2.5 py-2 text-body',
                    hints?.[o.value] ? 'items-start' : 'items-center whitespace-nowrap',
                    active ? 'font-medium text-accent-fg' : 'text-ink',
                    i === highlight && (active ? 'bg-accent-weak' : 'bg-hover'),
                    active && i !== highlight && 'bg-accent-weak/60',
                    o.disabled && 'cursor-not-allowed opacity-40',
                    o.value === '' && !active && 'text-ink-3',
                  )}
                >
                  <span className={cn('grid size-4 shrink-0 place-items-center text-accent', hints?.[o.value] && 'mt-0.5')}>{active && <Check size={14} />}</span>
                  {hints?.[o.value] ? (
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{o.label}</span>
                      <span className="mt-0.5 block text-xs font-normal leading-snug text-ink-3">{hints[o.value]}</span>
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  },
);
Select.displayName = 'Select';

export { Select };
