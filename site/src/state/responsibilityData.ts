import { useEffect, useState } from 'react';
import { parseRows, type AuditFile, type RespFile, type RespRow, type RulesFile } from '../lib/responsibility';

// responsibility*.json are loaded when the tab opens; narratives.json (4 MB) only when a crash's detail is opened.

const base = import.meta.env.BASE_URL;
async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${base}data/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export type RespData = { rows: RespRow[]; rulesVersion: string; labelSet: string; disclaimer: string; rules: RulesFile; audit: AuditFile };

let respPromise: Promise<RespData> | null = null;
export function loadResponsibility(): Promise<RespData> {
  respPromise ??= Promise.all([getJson<RespFile>('responsibility.json'), getJson<RulesFile>('responsibility_rules.json'), getJson<AuditFile>('responsibility_audit.json')]).then(
    ([file, rules, audit]) => ({ rows: parseRows(file), rulesVersion: file.rules_version, labelSet: file.label_set, disclaimer: file.disclaimer, rules, audit }),
  );
  respPromise.catch(() => (respPromise = null));
  return respPromise;
}

export function useResponsibility(): { resp: RespData | null; error: string | null } {
  const [resp, setResp] = useState<RespData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadResponsibility().then((r) => live && setResp(r), (e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, []);
  return { resp, error };
}

let narrPromise: Promise<Record<string, string>> | null = null;
export function loadNarratives(): Promise<Record<string, string>> {
  narrPromise ??= getJson<Record<string, string>>('narratives.json');
  narrPromise.catch(() => (narrPromise = null));
  return narrPromise;
}

/** The narrative for a report: text, 'redacted' when the file has none for it, 'loading' or 'error'. */
export type NarrativeState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'redacted' } | { status: 'text'; text: string };

export function useNarrative(reportId: string | null): NarrativeState {
  const [s, setS] = useState<NarrativeState>({ status: 'loading' });
  useEffect(() => {
    if (!reportId) return;
    let live = true;
    setS({ status: 'loading' });
    loadNarratives().then(
      (n) => {
        if (!live) return;
        const t = n[reportId];
        setS(t && t.trim() ? { status: 'text', text: t } : { status: 'redacted' });
      },
      (e) => live && setS({ status: 'error', message: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [reportId]);
  return s;
}
