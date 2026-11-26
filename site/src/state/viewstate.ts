import { setQuery } from './scenario';

// Small helpers for list-valued URL parameters ("a,b,c"). View state lives in the URL so a view can be shared.

export const getList = (p: URLSearchParams, key: string): string[] => (p.get(key) ?? '').split(',').filter(Boolean);
export const setList = (key: string, list: string[]) => setQuery({ [key]: list.length ? list.join(',') : null });
export const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
