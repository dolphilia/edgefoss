export type PathErrorCode =
  | "empty_path"
  | "path_too_long"
  | "non_nfc"
  | "absolute_path"
  | "trailing_slash"
  | "empty_segment"
  | "dot_segment"
  | "segment_too_long"
  | "control_character"
  | "forbidden_character"
  | "trailing_dot_or_space"
  | "windows_reserved_name";

export class PathError extends Error {
  constructor(
    readonly code: PathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PathError";
  }
}

const textEncoder = new TextEncoder();
const windowsReserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

function reject(code: PathErrorCode, message: string): never {
  throw new PathError(code, message);
}

/** Validates one path against `edgefossil-path-v0`. */
export function validatePath(path: string): void {
  const encodedLength = textEncoder.encode(path).length;
  if (encodedLength === 0) reject("empty_path", "path must not be empty");
  if (encodedLength > 4096)
    reject("path_too_long", "path exceeds 4096 UTF-8 bytes");
  if (path.normalize("NFC") !== path)
    reject("non_nfc", "path must already be Unicode NFC");
  if (path.startsWith("/"))
    reject("absolute_path", "absolute paths are forbidden");
  if (path.endsWith("/"))
    reject("trailing_slash", "path must not end with a separator");

  for (const segment of path.split("/")) {
    if (segment.length === 0)
      reject("empty_segment", "empty path segments are forbidden");
    if (segment === "." || segment === "..")
      reject("dot_segment", "dot path segments are forbidden");
    if (textEncoder.encode(segment).length > 255) {
      reject("segment_too_long", "path segment exceeds 255 UTF-8 bytes");
    }
    for (const character of segment) {
      const codePoint = character.codePointAt(0)!;
      if (codePoint <= 0x1f || codePoint === 0x7f) {
        reject("control_character", "control characters are forbidden");
      }
      if ('<>:"\\|?*'.includes(character)) {
        reject(
          "forbidden_character",
          "platform-forbidden ASCII characters are forbidden",
        );
      }
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      reject(
        "trailing_dot_or_space",
        "segments must not end with dot or space",
      );
    }
    const deviceStem = segment.split(".", 1)[0]!.toUpperCase();
    if (windowsReserved.test(deviceStem)) {
      reject("windows_reserved_name", "Windows device names are forbidden");
    }
  }
}
