"use client";
import { useCallback, useEffect, useState } from "react";

// Theme state lives on the <html> class (.dark or absent). We sync to localStorage
// so the choice persists, and the LAYOUT script in <head> applies it pre-paint
// to avoid a flash on initial load.

export type Theme = "dark" | "light";
const STORAGE_KEY = "docroom_theme";

function applyToDom(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function readInitial(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark");

  // Sync from DOM (which the head script already set from localStorage).
  useEffect(() => {
    setThemeState(readInitial());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyToDom(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyToDom(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
      return next;
    });
  }, []);

  return { theme, setTheme, toggleTheme };
}
