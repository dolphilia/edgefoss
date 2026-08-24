const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const MAX_ARTIFACT_BYTES = 1024 * 1024;

export type CborValue =
  | bigint
  | Uint8Array
  | string
  | boolean
  | null
  | CborValue[]
  | Map<string, CborValue>;

export type FormatErrorCode =
  | "invalid_cbor"
  | "non_canonical"
  | "unsupported_type"
  | "invalid_text"
  | "duplicate_key"
  | "resource_limit"
  | "invalid_schema"
  | "invalid_artifact_id"
  | "path_collision";

export class FormatError extends Error {
  constructor(
    readonly code: FormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FormatError";
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodeHead(major: number, argument: bigint): Uint8Array {
  if (argument < 0n || argument > 0xffff_ffff_ffff_ffffn) {
    throw new FormatError("invalid_schema", "CBOR integer is outside uint64");
  }
  if (argument < 24n) return Uint8Array.of((major << 5) | Number(argument));

  let width: 1 | 2 | 4 | 8;
  let additional: number;
  if (argument <= 0xffn) {
    width = 1;
    additional = 24;
  } else if (argument <= 0xffffn) {
    width = 2;
    additional = 25;
  } else if (argument <= 0xffff_ffffn) {
    width = 4;
    additional = 26;
  } else {
    width = 8;
    additional = 27;
  }

  const result = new Uint8Array(1 + width);
  result[0] = (major << 5) | additional;
  let remaining = argument;
  for (let index = width; index > 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function assertNfc(value: string): void {
  if (value.normalize("NFC") !== value) {
    throw new FormatError("invalid_text", "text must already be Unicode NFC");
  }
}

export function encodeCanonical(value: CborValue): Uint8Array {
  if (typeof value === "bigint") return encodeHead(0, value);
  if (value instanceof Uint8Array) {
    return concat([encodeHead(2, BigInt(value.length)), value]);
  }
  if (typeof value === "string") {
    assertNfc(value);
    const encoded = textEncoder.encode(value);
    return concat([encodeHead(3, BigInt(encoded.length)), encoded]);
  }
  if (Array.isArray(value)) {
    return concat([
      encodeHead(4, BigInt(value.length)),
      ...value.map(encodeCanonical),
    ]);
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, entryValue]) => {
      assertNfc(key);
      return {
        key,
        keyBytes: encodeCanonical(key),
        valueBytes: encodeCanonical(entryValue),
      };
    });
    if (new Set(entries.map(({ key }) => key)).size !== entries.length) {
      throw new FormatError("duplicate_key", "map contains duplicate keys");
    }
    entries.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
    return concat([
      encodeHead(5, BigInt(entries.length)),
      ...entries.flatMap(({ keyBytes, valueBytes }) => [keyBytes, valueBytes]),
    ]);
  }
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === null) return Uint8Array.of(0xf6);
  throw new FormatError("unsupported_type", "unsupported CBOR value");
}

class Decoder {
  private offset = 0;
  private items = 0;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw new FormatError("resource_limit", "artifact exceeds 1 MiB");
    }
  }

  decode(): CborValue {
    const value = this.item(0);
    if (this.offset !== this.bytes.length) {
      throw new FormatError("invalid_cbor", "trailing bytes after CBOR item");
    }
    return value;
  }

  private byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) {
      throw new FormatError("invalid_cbor", "unexpected end of input");
    }
    this.offset += 1;
    return value;
  }

  private argument(additional: number): bigint {
    if (additional < 24) return BigInt(additional);
    if (additional === 31) {
      throw new FormatError(
        "unsupported_type",
        "indefinite length is forbidden",
      );
    }
    const width =
      additional === 24
        ? 1
        : additional === 25
          ? 2
          : additional === 26
            ? 4
            : additional === 27
              ? 8
              : 0;
    if (width === 0)
      throw new FormatError("invalid_cbor", "reserved additional information");
    let value = 0n;
    for (let index = 0; index < width; index += 1)
      value = (value << 8n) | BigInt(this.byte());
    const minimum =
      width === 1
        ? 24n
        : width === 2
          ? 0x100n
          : width === 4
            ? 0x1_0000n
            : 0x1_0000_0000n;
    if (value < minimum)
      throw new FormatError("non_canonical", "non-shortest CBOR argument");
    return value;
  }

  private length(value: bigint): number {
    if (value > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new FormatError("resource_limit", "CBOR collection is too large");
    }
    return Number(value);
  }

  private slice(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length)
      throw new FormatError("invalid_cbor", "truncated CBOR value");
    const value = this.bytes.slice(this.offset, end);
    this.offset = end;
    return value;
  }

  private item(depth: number): CborValue {
    if (depth > 64)
      throw new FormatError("resource_limit", "CBOR nesting exceeds 64");
    this.items += 1;
    if (this.items > 65_536)
      throw new FormatError("resource_limit", "too many CBOR items");

    const initial = this.byte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      throw new FormatError(
        "unsupported_type",
        "unsupported simple or floating-point value",
      );
    }
    if (major === 1 || major === 6) {
      throw new FormatError(
        "unsupported_type",
        "negative integers and tags are forbidden",
      );
    }
    const argument = this.argument(additional);
    if (major === 0) return argument;
    if (major === 2) return this.slice(this.length(argument));
    if (major === 3) {
      let text: string;
      try {
        text = textDecoder.decode(this.slice(this.length(argument)));
      } catch {
        throw new FormatError("invalid_text", "text is not valid UTF-8");
      }
      assertNfc(text);
      return text;
    }
    if (major === 4) {
      return Array.from({ length: this.length(argument) }, () =>
        this.item(depth + 1),
      );
    }
    if (major === 5) {
      const result = new Map<string, CborValue>();
      let previousKeyBytes: Uint8Array | undefined;
      for (let index = 0; index < this.length(argument); index += 1) {
        const keyStart = this.offset;
        const key = this.item(depth + 1);
        const keyBytes = this.bytes.slice(keyStart, this.offset);
        if (typeof key !== "string")
          throw new FormatError("unsupported_type", "map keys must be text");
        if (result.has(key))
          throw new FormatError("duplicate_key", `duplicate map key: ${key}`);
        if (
          previousKeyBytes !== undefined &&
          compareBytes(previousKeyBytes, keyBytes) >= 0
        ) {
          throw new FormatError(
            "non_canonical",
            "map keys are not in canonical order",
          );
        }
        result.set(key, this.item(depth + 1));
        previousKeyBytes = keyBytes;
      }
      return result;
    }
    throw new FormatError(
      "unsupported_type",
      `CBOR major type ${major} is forbidden`,
    );
  }
}

export function decodeCanonical(bytes: Uint8Array): CborValue {
  const value = new Decoder(bytes).decode();
  const canonical = encodeCanonical(value);
  if (
    compareBytes(canonical, bytes) !== 0 ||
    canonical.length !== bytes.length
  ) {
    throw new FormatError(
      "non_canonical",
      "CBOR bytes do not match deterministic re-encoding",
    );
  }
  return value;
}
