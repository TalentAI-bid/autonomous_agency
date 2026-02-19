'use client';

import * as React from 'react';

type ToastVariant = 'default' | 'destructive' | 'success';

interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
}

type Action =
  | { type: 'ADD'; toast: Toast }
  | { type: 'REMOVE'; id: string };

function reducer(state: ToastState, action: Action): ToastState {
  switch (action.type) {
    case 'ADD':
      return { toasts: [action.toast, ...state.toasts].slice(0, 5) };
    case 'REMOVE':
      return { toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

const listeners: Array<(state: ToastState) => void> = [];
let memoryState: ToastState = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((l) => l(memoryState));
}

let count = 0;

export function toast(props: Omit<Toast, 'id'>) {
  const id = `toast-${++count}`;
  const duration = props.duration ?? 4000;

  dispatch({ type: 'ADD', toast: { ...props, id } });
  setTimeout(() => dispatch({ type: 'REMOVE', id }), duration);

  return id;
}

export function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const idx = listeners.indexOf(setState);
      if (idx > -1) listeners.splice(idx, 1);
    };
  }, []);

  return { toasts: state.toasts, toast };
}
