/** Narrows `value` to one of a literal list, e.g. an `as const` array */
export const isOneOf = <T>(list: readonly T[], value: unknown): value is T =>
  list.some((item) => item === value)

/** A JSON object, as opposed to an array, null, or a primitive */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isString = (value: unknown): value is string => typeof value === "string"

export const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string"

/** A non-empty string, or null for anything else */
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
