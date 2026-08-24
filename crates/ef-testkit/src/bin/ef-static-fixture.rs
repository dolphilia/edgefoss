//! Writes a small generated public site for provider-profile smoke tests.

use std::{
    env,
    error::Error,
    fs,
    path::{Component, Path, PathBuf},
};

use ed25519_dalek::{Signer, SigningKey};
use edgefoss_core::{SnapshotInput, SnapshotInputKind, build_realm_snapshots};
use ef_format::{
    ArtifactMeta, ChangeArtifact, ProjectGenesis, Realm, SignatureRecord, artifact_id,
    artifact_signature_message, encode_change,
};
use ef_static_site::build_public_site;
use ef_store_sqlite::LocalRepository;

fn main() -> Result<(), Box<dyn Error>> {
    let output = parse_output()?;
    if output.exists() {
        return Err(format!("output already exists: {}", output.display()).into());
    }
    let site = fixture_site()?;
    fs::create_dir(&output)?;
    let result = write_files(&output, &site.files);
    if result.is_err() {
        let _ = fs::remove_dir_all(&output);
    }
    result?;
    println!("site: {}", output.display());
    println!("semantic-root: {}", site.semantic_root);
    Ok(())
}

fn parse_output() -> Result<PathBuf, Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--output")) {
        return Err("usage: ef-static-fixture --output SITE_DIRECTORY".into());
    }
    let output = arguments.next().ok_or("missing SITE_DIRECTORY")?;
    if arguments.next().is_some() {
        return Err("unexpected trailing argument".into());
    }
    Ok(PathBuf::from(output))
}

fn fixture_site() -> Result<ef_static_site::StaticSite, Box<dyn Error>> {
    let key = SigningKey::from_bytes(&[31; 32]);
    let genesis = ProjectGenesis {
        name: "EdgeFossil static smoke".into(),
        nonce: [32; 32],
        actor_key: key.verifying_key().to_bytes(),
        created_at: "2026-08-25T00:00:00Z".into(),
    };
    let mut repository = LocalRepository::open_in_memory()?;
    let project = repository.init_project(&genesis)?;
    let snapshots = build_realm_snapshots(
        &project,
        genesis.actor_key,
        &genesis.created_at,
        &[
            SnapshotInput {
                path: "README.md".into(),
                realm: Realm::Public,
                kind: SnapshotInputKind::File {
                    bytes: b"public smoke content\n".to_vec(),
                    executable: false,
                },
            },
            SnapshotInput {
                path: "members.txt".into(),
                realm: Realm::Members,
                kind: SnapshotInputKind::File {
                    bytes: b"members-smoke-secret".to_vec(),
                    executable: false,
                },
            },
            SnapshotInput {
                path: "local.txt".into(),
                realm: Realm::Local,
                kind: SnapshotInputKind::File {
                    bytes: b"local-smoke-secret".to_vec(),
                    executable: false,
                },
            },
        ],
    )?;
    repository.replace_working_snapshots(&snapshots, "2026-08-25T00:00:01Z")?;
    let basis = repository.checkpoint_basis(Realm::Public)?;
    let change = ChangeArtifact {
        meta: ArtifactMeta {
            project: basis.project.clone(),
            realm: Realm::Public,
            parents: vec![],
            actor_key: basis.actor_key,
            logical_clock: basis.logical_clock,
            created_at: "2026-08-25T00:00:02Z".into(),
        },
        root: basis.root.clone(),
        message: "public static smoke".into(),
    };
    let change_id = artifact_id(&encode_change(&change)?);
    let mut signed = basis.artifacts_to_sign;
    signed.push(change_id);
    let signatures = signed
        .iter()
        .map(|id| sign(&key, id))
        .collect::<Result<Vec<_>, _>>()?;
    repository.commit_checkpoint(&change, basis.expected_generation, &signatures)?;
    let bundle = repository.export_bundle(Realm::Public, &[])?;
    Ok(build_public_site(&bundle.manifest_bytes, &bundle.objects)?)
}

fn sign(key: &SigningKey, artifact: &str) -> Result<SignatureRecord, Box<dyn Error>> {
    Ok(SignatureRecord {
        artifact: artifact.into(),
        actor_key: key.verifying_key().to_bytes(),
        signature: key.sign(&artifact_signature_message(artifact)?).to_bytes(),
    })
}

fn write_files(
    root: &Path,
    files: &std::collections::BTreeMap<String, Vec<u8>>,
) -> Result<(), Box<dyn Error>> {
    for (relative, body) in files {
        let relative = Path::new(relative);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("fixture contains an unsafe output path".into());
        }
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, body)?;
    }
    Ok(())
}
