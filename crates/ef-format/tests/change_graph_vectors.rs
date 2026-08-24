use std::{collections::HashMap, str::FromStr};

use ef_format::{
    ArtifactMeta, ChangeArtifact, FormatErrorCode, GraphArtifactKind, GraphArtifactSummary, Realm,
    validate_change_graph,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct GraphVectors {
    profile: String,
    project: String,
    other_project: String,
    root_id: String,
    parent_id: String,
    actor_key_hex: String,
    other_actor_key_hex: String,
    cases: Vec<GraphCase>,
}

#[derive(Deserialize)]
struct GraphCase {
    name: String,
    change_realm: String,
    #[serde(default)]
    clock: u64,
    root: RootRelation,
    parent: Option<ParentRelation>,
    allowed: Option<bool>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct RootRelation {
    present: bool,
    project: String,
    realm: String,
    kind: String,
}

#[derive(Deserialize)]
struct ParentRelation {
    project: String,
    realm: String,
    kind: String,
    actor: String,
    clock: u64,
}

fn vectors() -> GraphVectors {
    serde_json::from_str(include_str!("../../../spec/vectors/change-graph-v0.json"))
        .expect("valid change graph vectors")
}

fn decode_key(value: &str) -> [u8; 32] {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII hex"), 16)
                .expect("valid hex")
        })
        .collect::<Vec<_>>()
        .try_into()
        .expect("32-byte key")
}

fn kind(value: &str) -> GraphArtifactKind {
    match value {
        "tree" => GraphArtifactKind::Tree,
        "change" => GraphArtifactKind::Change,
        _ => panic!("unknown graph kind"),
    }
}

fn error_name(code: FormatErrorCode) -> &'static str {
    match code {
        FormatErrorCode::CrossProjectReference => "cross_project_reference",
        FormatErrorCode::ParentRealmMismatch => "parent_realm_mismatch",
        FormatErrorCode::RealmFlowDenied => "realm_flow_denied",
        FormatErrorCode::UnknownRequiredSemantics => "unknown_required_semantics",
        FormatErrorCode::InvalidLogicalClock => "invalid_logical_clock",
        _ => "unexpected_error",
    }
}

#[test]
fn change_graph_matches_shared_vectors() {
    let vectors = vectors();
    assert_eq!(vectors.profile, "edgefossil-change-graph-v0");
    let actor_key = decode_key(&vectors.actor_key_hex);
    let other_actor_key = decode_key(&vectors.other_actor_key_hex);

    for vector in &vectors.cases {
        let relation_project = |relation: &str| {
            if relation == "same" {
                vectors.project.clone()
            } else {
                vectors.other_project.clone()
            }
        };
        let mut summaries = HashMap::new();
        if vector.root.present {
            summaries.insert(
                vectors.root_id.clone(),
                GraphArtifactSummary {
                    project: relation_project(&vector.root.project),
                    realm: Realm::from_str(&vector.root.realm).expect("root realm"),
                    kind: kind(&vector.root.kind),
                    actor_key,
                    logical_clock: 0,
                },
            );
        }
        if let Some(parent) = &vector.parent {
            summaries.insert(
                vectors.parent_id.clone(),
                GraphArtifactSummary {
                    project: relation_project(&parent.project),
                    realm: Realm::from_str(&parent.realm).expect("parent realm"),
                    kind: kind(&parent.kind),
                    actor_key: if parent.actor == "same" {
                        actor_key
                    } else {
                        other_actor_key
                    },
                    logical_clock: parent.clock,
                },
            );
        }
        let change = ChangeArtifact {
            meta: ArtifactMeta {
                project: vectors.project.clone(),
                realm: Realm::from_str(&vector.change_realm).expect("change realm"),
                parents: vector
                    .parent
                    .as_ref()
                    .map_or_else(Vec::new, |_| vec![vectors.parent_id.clone()]),
                actor_key,
                logical_clock: vector.clock,
                created_at: "2026-08-24T00:03:00Z".into(),
            },
            root: vectors.root_id.clone(),
            message: "graph vector".into(),
        };
        match validate_change_graph(&change, |id| summaries.get(id).cloned()) {
            Ok(()) => assert_eq!(vector.allowed, Some(true), "{}", vector.name),
            Err(error) => assert_eq!(
                Some(error_name(error.code)),
                vector.error.as_deref(),
                "{}",
                vector.name
            ),
        }
    }
}
