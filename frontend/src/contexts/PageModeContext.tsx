import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface PageModeContextValue {
  isPageMode: boolean;
  setIsPageMode: (value: boolean) => void;
}

const PageModeContext = createContext<PageModeContextValue>({
  isPageMode: false,
  setIsPageMode: () => {},
});

export function PageModeProvider({ children }: { children: ReactNode }) {
  const [isPageMode, setIsPageModeState] = useState(false);
  const setIsPageMode = useCallback((value: boolean) => setIsPageModeState(value), []);

  return (
    <PageModeContext.Provider value={{ isPageMode, setIsPageMode }}>
      {children}
    </PageModeContext.Provider>
  );
}

export function usePageMode() {
  return useContext(PageModeContext);
}
