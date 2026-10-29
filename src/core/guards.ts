// Type guards for untrusted values (stored or received). Pure: no chrome,
// no DOM.

export type Raw = Record<string, unknown>

// A plain object: not null, not an array.
export const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
