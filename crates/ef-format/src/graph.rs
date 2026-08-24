//! Resolved graph validation for schema-0 changes.

use crate::{ChangeArtifact, FormatError, FormatErrorCode, Realm, ReferenceClass, can_reference};

/// Artifact kinds needed while resolving a change graph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphArtifactKind {
    Tree,
    Change,
}

/// Resolved metadata needed to validate an immutable graph edge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphArtifactSummary {
    pub project: String,
    pub realm: Realm,
    pub kind: GraphArtifactKind,
    pub actor_key: [u8; 32],
    pub logical_clock: u64,
}

/// Resolves and validates the graph edges of one schema-0 change.
///
/// # Errors
///
/// Returns a stable graph error when an edge cannot be resolved or violates
/// project, kind, realm-flow, or same-actor logical-clock rules.
pub fn validate_change_graph(
    change: &ChangeArtifact,
    resolve: impl Fn(&str) -> Option<GraphArtifactSummary>,
) -> Result<(), FormatError> {
    let root = resolve(&change.root).ok_or_else(|| {
        FormatError::new(
            FormatErrorCode::UnknownRequiredSemantics,
            "root is unavailable or is not a tree",
        )
    })?;
    if root.kind != GraphArtifactKind::Tree {
        return Err(FormatError::new(
            FormatErrorCode::UnknownRequiredSemantics,
            "root is unavailable or is not a tree",
        ));
    }
    if root.project != change.meta.project {
        return Err(FormatError::new(
            FormatErrorCode::CrossProjectReference,
            "root belongs to another project",
        ));
    }
    if !can_reference(change.meta.realm, root.realm, ReferenceClass::Content) {
        return Err(FormatError::new(
            FormatErrorCode::RealmFlowDenied,
            "root realm is not readable from change realm",
        ));
    }

    for parent_id in &change.meta.parents {
        let parent = resolve(parent_id).ok_or_else(|| {
            FormatError::new(
                FormatErrorCode::UnknownRequiredSemantics,
                "parent is unavailable or is not a change",
            )
        })?;
        if parent.kind != GraphArtifactKind::Change {
            return Err(FormatError::new(
                FormatErrorCode::UnknownRequiredSemantics,
                "parent is unavailable or is not a change",
            ));
        }
        if parent.project != change.meta.project {
            return Err(FormatError::new(
                FormatErrorCode::CrossProjectReference,
                "parent belongs to another project",
            ));
        }
        if !can_reference(change.meta.realm, parent.realm, ReferenceClass::Parent) {
            return Err(FormatError::new(
                FormatErrorCode::ParentRealmMismatch,
                "parent realm differs from change realm",
            ));
        }
        if parent.actor_key == change.meta.actor_key
            && change.meta.logical_clock <= parent.logical_clock
        {
            return Err(FormatError::new(
                FormatErrorCode::InvalidLogicalClock,
                "logical clock must advance same-actor parents",
            ));
        }
    }
    Ok(())
}
