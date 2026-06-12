"use client";
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import th from "./locales/th";
import en from "./locales/en";

export type Locale = "th" | "en";

const DICTS = { th, en } as const;
const STORAGE_KEY = "docroom_locale";

interface LocaleCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<LocaleCtx | null>(null);

// Walk dotted key path: "ocr.uploadHeadline" → DICT.ocr.uploadHeadline
function resolve(dict: any, key: string): string {
  const parts = key.split(".");
  let cur = dict;
  for (const p of parts) {
    if (cur == null) return key;
    cur = cur[p];
  }
  return typeof cur === "string" ? cur : key;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("th");

  // Hydrate from localStorage post-mount (avoids SSR mismatch).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
      if (saved === "th" || saved === "en") setLocaleState(saved);
    } catch {}
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch {}
  }, []);

  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    const dict = DICTS[locale] ?? DICTS.th;
    return interpolate(resolve(dict, key), vars);
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTranslation() {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Fallback so components don't crash if Provider is missing (e.g. tests).
    return {
      locale: "th" as Locale,
      setLocale: () => {},
      t: (key: string, vars?: Record<string, string | number>) => interpolate(resolve(th, key), vars),
    };
  }
  return ctx;
}
