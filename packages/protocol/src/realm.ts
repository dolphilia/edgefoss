export const realms = ["public", "members", "local"] as const;
export type Realm = (typeof realms)[number];
export type ReferenceClass = "parent" | "content";

/** Returns whether a v0 source realm may identify the target realm. */
export function canReference(
  source: Realm,
  target: Realm,
  referenceClass: ReferenceClass,
): boolean {
  if (referenceClass === "parent") return source === target;
  if (source === "public") return target === "public";
  if (source === "members") return target !== "local";
  return true;
}

/** Parses a built-in v0 realm without accepting future values accidentally. */
export function parseRealm(value: string): Realm | undefined {
  return realms.find((realm) => realm === value);
}
