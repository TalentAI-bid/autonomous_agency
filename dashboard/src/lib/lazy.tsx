'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * Lazy-load a component that is controlled by an `open` prop (a panel or modal).
 * Its code is only fetched the first time `open` becomes true; after that it stays
 * mounted, so internal state (a chat in progress, a half-written email) survives closing.
 */
export function lazyOnOpen<P extends { open: boolean }>(loader: () => Promise<React.ComponentType<P>>) {
  const Component = dynamic(loader, { ssr: false }) as React.ComponentType<P>;
  return function LazyOnOpen(props: P) {
    const [seen, setSeen] = React.useState(props.open);
    React.useEffect(() => {
      if (props.open) setSeen(true);
    }, [props.open]);
    return seen ? <Component {...props} /> : null;
  };
}
