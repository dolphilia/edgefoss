//! Portable repository-path validation.

use std::{error::Error, fmt};

use unicode_normalization::UnicodeNormalization;

/// Stable machine-readable path validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathErrorCode {
    EmptyPath,
    PathTooLong,
    NonNfc,
    AbsolutePath,
    TrailingSlash,
    EmptySegment,
    DotSegment,
    SegmentTooLong,
    ControlCharacter,
    ForbiddenCharacter,
    TrailingDotOrSpace,
    WindowsReservedName,
}

/// A path rejected by `edgefossil-path-v0`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathError {
    /// Stable failure category.
    pub code: PathErrorCode,
    message: &'static str,
}

impl PathError {
    const fn new(code: PathErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl fmt::Display for PathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for PathError {}

fn is_windows_reserved(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .expect("split always has one item");
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

/// Validates one path against `edgefossil-path-v0`.
///
/// # Errors
///
/// Returns the first failure in the profile's deterministic validation order.
pub fn validate_path(path: &str) -> Result<(), PathError> {
    if path.is_empty() {
        return Err(PathError::new(
            PathErrorCode::EmptyPath,
            "path must not be empty",
        ));
    }
    if path.len() > 4096 {
        return Err(PathError::new(
            PathErrorCode::PathTooLong,
            "path exceeds 4096 UTF-8 bytes",
        ));
    }
    if !path.nfc().eq(path.chars()) {
        return Err(PathError::new(
            PathErrorCode::NonNfc,
            "path must already be Unicode NFC",
        ));
    }
    if path.starts_with('/') {
        return Err(PathError::new(
            PathErrorCode::AbsolutePath,
            "absolute paths are forbidden",
        ));
    }
    if path.ends_with('/') {
        return Err(PathError::new(
            PathErrorCode::TrailingSlash,
            "path must not end with a separator",
        ));
    }

    for segment in path.split('/') {
        if segment.is_empty() {
            return Err(PathError::new(
                PathErrorCode::EmptySegment,
                "empty path segments are forbidden",
            ));
        }
        if matches!(segment, "." | "..") {
            return Err(PathError::new(
                PathErrorCode::DotSegment,
                "dot path segments are forbidden",
            ));
        }
        if segment.len() > 255 {
            return Err(PathError::new(
                PathErrorCode::SegmentTooLong,
                "path segment exceeds 255 UTF-8 bytes",
            ));
        }
        for character in segment.chars() {
            if character <= '\u{1f}' || character == '\u{7f}' {
                return Err(PathError::new(
                    PathErrorCode::ControlCharacter,
                    "control characters are forbidden",
                ));
            }
            if matches!(character, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*') {
                return Err(PathError::new(
                    PathErrorCode::ForbiddenCharacter,
                    "platform-forbidden ASCII characters are forbidden",
                ));
            }
        }
        if segment.ends_with(['.', ' ']) {
            return Err(PathError::new(
                PathErrorCode::TrailingDotOrSpace,
                "segments must not end with dot or space",
            ));
        }
        if is_windows_reserved(segment) {
            return Err(PathError::new(
                PathErrorCode::WindowsReservedName,
                "Windows device names are forbidden",
            ));
        }
    }
    Ok(())
}
