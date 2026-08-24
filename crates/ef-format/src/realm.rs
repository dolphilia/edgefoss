//! Realm flow validation for the built-in v0 realms.

use std::str::FromStr;

/// A built-in v0 disclosure realm.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Realm {
    Public,
    Members,
    Local,
}

impl Realm {
    /// Returns the canonical v0 text form.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Members => "members",
            Self::Local => "local",
        }
    }
}

/// A graph-edge class with realm-specific rules.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceClass {
    Parent,
    Content,
}

/// Error returned when parsing an unknown v0 realm.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParseRealmError;

impl FromStr for Realm {
    type Err = ParseRealmError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "public" => Ok(Self::Public),
            "members" => Ok(Self::Members),
            "local" => Ok(Self::Local),
            _ => Err(ParseRealmError),
        }
    }
}

/// Returns whether a v0 source realm may identify the target realm.
#[must_use]
pub const fn can_reference(source: Realm, target: Realm, reference_class: ReferenceClass) -> bool {
    match reference_class {
        ReferenceClass::Parent => {
            matches!(
                (source, target),
                (Realm::Public, Realm::Public)
                    | (Realm::Members, Realm::Members)
                    | (Realm::Local, Realm::Local)
            )
        }
        ReferenceClass::Content => match source {
            Realm::Public => matches!(target, Realm::Public),
            Realm::Members => matches!(target, Realm::Public | Realm::Members),
            Realm::Local => true,
        },
    }
}
