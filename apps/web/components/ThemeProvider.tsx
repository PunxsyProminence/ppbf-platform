"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/* The platform ships ONE look: the golden-era design system in
   design-system/ppbf.css, applied unconditionally by app/globals.css.

   This provider is kept wired but inert on purpose — a second theme is a
   planned feature, not a current one. Nothing reads data-theme any more (the
   [data-theme="retro"] rules that used to gate the golden-era styling are now
   unconditional), and ThemeToggle is no longer mounted in the global header.
   Restoring a real toggle means adding a second palette block back to
   globals.css and re-mounting ThemeToggle; the plumbing below is what makes
   that a small change rather than a rewrite. */
export type PpbfTheme = "tactical" | "retro";

const STORAGE_KEY = "ppbf-theme";
const THEME_CHANGE_EVENT = "ppbf-theme-change";
const DEFAULT_THEME: PpbfTheme = "retro";

type ThemeContextValue = {
  theme: PpbfTheme;
  setTheme: (theme: PpbfTheme) => void;
  toggleTheme: () => void;
  isRetro: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyThemeToDocument(theme: PpbfTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "retro") {
    root.setAttribute("data-theme", "retro");
  } else {
    root.removeAttribute("data-theme");
  }
}

function readStoredTheme(): PpbfTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === "tactical") return "tactical";
    if (value === "retro") return "retro";
    return DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function subscribe(onStoreChange: () => void) {
  const handler = () => onStoreChange();
  window.addEventListener("storage", handler);
  window.addEventListener(THEME_CHANGE_EVENT, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
  };
}

function getSnapshot(): PpbfTheme {
  return readStoredTheme();
}

function getServerSnapshot(): PpbfTheme {
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // DOM side-effect only — no setState (satisfies react-hooks/set-state-in-effect)
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const setTheme = useCallback((next: PpbfTheme) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore quota / private mode
    }
    applyThemeToDocument(next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "retro" ? "tactical" : "retro");
  }, [setTheme, theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      isRetro: theme === "retro",
    }),
    [theme, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      <div data-theme-ready="true">{children}</div>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}

/** Safe for places that may render outside provider (returns default theme). */
export function useThemeOptional(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  return (
    ctx ?? {
      theme: DEFAULT_THEME,
      setTheme: () => undefined,
      toggleTheme: () => undefined,
      isRetro: DEFAULT_THEME === "retro",
    }
  );
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme, isRetro } = useThemeOptional();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={
        className ||
        "border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-1 text-[11px] font-mono uppercase text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
      }
      aria-pressed={isRetro}
      title={isRetro ? "Switch to tactical theme" : "Switch to retro golden-era theme"}
    >
      {theme === "retro" ? "Theme: Retro" : "Theme: Tactical"}
    </button>
  );
}
