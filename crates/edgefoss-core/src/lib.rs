//! Portable `EdgeFossil` domain primitives.
//!
//! Cloudflare resource identifiers and runtime bindings must not enter this
//! crate. The initial module is deliberately small; executable format work
//! starts in P1.

/// The compatibility status used while the v0 artifact format is still under
/// executable-specification development.
pub const FORMAT_STATUS: &str = "experimental";

/// Returns the stable product name used by cross-runtime smoke tests.
#[must_use]
pub const fn product_name() -> &'static str {
    "EdgeFossil"
}

#[cfg(test)]
mod tests {
    use super::{FORMAT_STATUS, product_name};

    #[test]
    fn exposes_bootstrap_metadata() {
        assert_eq!(product_name(), "EdgeFossil");
        assert_eq!(FORMAT_STATUS, "experimental");
    }
}
