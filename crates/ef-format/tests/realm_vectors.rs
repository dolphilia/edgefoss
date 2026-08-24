use std::str::FromStr;

use ef_format::{Realm, ReferenceClass, can_reference};
use serde::Deserialize;

#[derive(Deserialize)]
struct RealmVectors {
    profile: String,
    cases: Vec<RealmCase>,
}

#[derive(Deserialize)]
struct RealmCase {
    name: String,
    source: String,
    target: String,
    class: String,
    allowed: bool,
}

fn vectors() -> RealmVectors {
    serde_json::from_str(include_str!("../../../spec/vectors/realm-flow-v0.json"))
        .expect("valid realm vector file")
}

#[test]
fn realm_flow_matches_shared_vectors() {
    let vectors = vectors();
    assert_eq!(vectors.profile, "edgefossil-realm-v0");
    for vector in vectors.cases {
        let source = Realm::from_str(&vector.source).expect("known source realm");
        let target = Realm::from_str(&vector.target).expect("known target realm");
        let reference_class = match vector.class.as_str() {
            "parent" => ReferenceClass::Parent,
            "content" => ReferenceClass::Content,
            _ => panic!("unknown reference class"),
        };
        assert_eq!(
            can_reference(source, target, reference_class),
            vector.allowed,
            "{}",
            vector.name
        );
    }
}

#[test]
fn unknown_realm_is_rejected() {
    assert!(Realm::from_str("maintainers").is_err());
}
