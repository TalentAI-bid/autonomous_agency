import { useState } from 'react';
import { useAgentCompanies } from '@/hooks/use-agents';

/**
 * State + query for the agent Companies tab. Lives in a hook (not the tab
 * component) because the page header also needs the loaded count for the
 * tab badge.
 *
 * Only toggle is the data-completeness filter (default hides zero/low-
 * completeness stubs). Nothing is hidden by score anymore; companies sort by
 * buyer_fit_score and the user scrolls.
 */
export function useCompaniesTab(agentId: string) {
  const [showOnlyWithData, setShowOnlyWithData] = useState(true);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;
  const { data } = useAgentCompanies(agentId, {
    includeIncomplete: !showOnlyWithData,
    cursor: currentCursor,
    sortBy: 'fit_score',
  });

  return {
    companies: data?.data ?? [],
    pagination: data?.pagination,
    showOnlyWithData,
    cursorStack,
    toggleShowOnlyWithData: () => {
      setShowOnlyWithData((v) => !v);
      setCursorStack([null]);
    },
    goPrevious: () => setCursorStack((s) => s.slice(0, -1)),
    goNext: (cursor: string) => setCursorStack((s) => [...s, cursor]),
  };
}

export type CompaniesTabState = ReturnType<typeof useCompaniesTab>;
