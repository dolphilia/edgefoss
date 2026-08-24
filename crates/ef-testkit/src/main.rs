use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Instant,
};

use ed25519_dalek::{Signer, SigningKey};
use edgefoss_core::{SnapshotInput, SnapshotInputKind, build_realm_snapshots};
use ef_format::{
    ArtifactMeta, BundleManifest, ChangeArtifact, ProjectGenesis, Realm, SemanticArtifact,
    SemanticRef, SemanticRootInput, SignatureRecord, TreeArtifact, artifact_id,
    artifact_signature_message, compute_semantic_root, encode_bundle_manifest, encode_change,
    encode_project_genesis, encode_signature_record, encode_tree,
};
use ef_store_sqlite::{
    LocalRepository, PortableBundle, TrackingMode, TrackingRule, TrackingScope,
    verify_portable_bundle,
};
use serde::Serialize;

const CHECKPOINT_REF: &str = "heads/main";

#[derive(Clone, Copy)]
struct Profile {
    name: &'static str,
    files: usize,
    changes_per_realm: usize,
    light_repetitions: usize,
    export_repetitions: usize,
}

impl Profile {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "smoke" => Ok(Self {
                name: "smoke",
                files: 100,
                changes_per_realm: 50,
                light_repetitions: 1,
                export_repetitions: 1,
            }),
            "g2" => Ok(Self {
                name: "g2",
                files: 10_000,
                changes_per_realm: 14_000,
                light_repetitions: 3,
                export_repetitions: 1,
            }),
            _ => Err("--profile must be smoke or g2".into()),
        }
    }
}

#[derive(Serialize)]
struct Report {
    format: &'static str,
    profile: &'static str,
    source_commit: String,
    source_dirty: bool,
    environment: Environment,
    fixtures: Vec<Fixture>,
    measurements: Vec<Measurement>,
}

#[derive(Serialize)]
struct Environment {
    os: String,
    architecture: &'static str,
    rustc: String,
    ef_binary: String,
}

#[derive(Serialize)]
struct Fixture {
    name: &'static str,
    files: usize,
    artifacts: usize,
    realms: usize,
}

#[derive(Serialize)]
struct Measurement {
    fixture: &'static str,
    command: String,
    elapsed_ms: Vec<u128>,
    minimum_ms: u128,
    median_ms: u128,
    maximum_ms: u128,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("ef-local-baseline: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut profile = None;
    let mut ef = None;
    let mut workdir = None;
    let mut output = None;
    let mut arguments = env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--profile") => {
                let value = arguments
                    .next()
                    .ok_or("--profile requires a value")?
                    .into_string()
                    .map_err(|_| "--profile must be UTF-8")?;
                profile = Some(Profile::parse(&value)?);
            }
            Some("--ef") => {
                ef = Some(PathBuf::from(
                    arguments.next().ok_or("--ef requires a path")?,
                ));
            }
            Some("--workdir") => {
                workdir = Some(PathBuf::from(
                    arguments.next().ok_or("--workdir requires a path")?,
                ));
            }
            Some("--output") => {
                output = Some(PathBuf::from(
                    arguments.next().ok_or("--output requires a path")?,
                ));
            }
            Some(value) => return Err(format!("unknown argument {value}")),
            None => return Err("arguments must be UTF-8 options".into()),
        }
    }
    let profile = profile.ok_or("missing --profile")?;
    let ef = canonical_file(&ef.ok_or("missing --ef")?)?;
    let workdir = workdir.ok_or("missing --workdir")?;
    let output = output.ok_or("missing --output")?;
    if workdir.exists() || output.exists() {
        return Err("--workdir and --output must not already exist".into());
    }
    fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;

    let mut fixtures = Vec::new();
    let mut measurements = Vec::new();
    build_file_fixture(profile, &ef, &workdir, &mut fixtures, &mut measurements)?;
    build_artifact_fixture(profile, &ef, &workdir, &mut fixtures, &mut measurements)?;
    let report = Report {
        format: "edgefossil-local-baseline-v0",
        profile: profile.name,
        source_commit: command_text("git", &["rev-parse", "HEAD"]),
        source_dirty: !command_text("git", &["status", "--porcelain"]).is_empty(),
        environment: Environment {
            os: command_text("uname", &["-srv"]),
            architecture: env::consts::ARCH,
            rustc: command_text("rustc", &["--version"]),
            ef_binary: ef.display().to_string(),
        },
        fixtures,
        measurements,
    };
    let body = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    fs::write(&output, body).map_err(|error| error.to_string())?;
    println!("baseline-report: {}", output.display());
    Ok(())
}

fn canonical_file(path: &Path) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    Ok(path)
}

fn command_text(program: &str, arguments: &[&str]) -> String {
    Command::new(program)
        .args(arguments)
        .output()
        .ok()
        .filter(Output::status_success)
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map_or_else(|| "unavailable".into(), |value| value.trim().to_owned())
}

trait OutputStatus {
    fn status_success(&self) -> bool;
}

impl OutputStatus for Output {
    fn status_success(&self) -> bool {
        self.status.success()
    }
}

fn run_ef(ef: &Path, arguments: &[String]) -> Result<u128, String> {
    let started = Instant::now();
    let output = Command::new(ef)
        .args(arguments)
        .output()
        .map_err(|error| error.to_string())?;
    let elapsed = started.elapsed().as_millis();
    if !output.status.success() {
        return Err(format!(
            "ef {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(elapsed)
}

fn record(
    measurements: &mut Vec<Measurement>,
    fixture: &'static str,
    command: impl Into<String>,
    mut elapsed_ms: Vec<u128>,
) {
    let mut sorted = elapsed_ms.clone();
    sorted.sort_unstable();
    measurements.push(Measurement {
        fixture,
        command: command.into(),
        minimum_ms: sorted[0],
        median_ms: sorted[sorted.len() / 2],
        maximum_ms: *sorted.last().unwrap(),
        elapsed_ms: std::mem::take(&mut elapsed_ms),
    });
}

fn repeated_ef(ef: &Path, arguments: &[String], repetitions: usize) -> Result<Vec<u128>, String> {
    (0..repetitions).map(|_| run_ef(ef, arguments)).collect()
}

fn artifact_count(database: &Path) -> Result<usize, String> {
    let connection = rusqlite::Connection::open(database).map_err(|error| error.to_string())?;
    let count: i64 = connection
        .query_row("SELECT count(*) FROM artifacts", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    usize::try_from(count).map_err(|error| error.to_string())
}

#[allow(clippy::too_many_lines)]
fn build_file_fixture(
    profile: Profile,
    ef: &Path,
    workdir: &Path,
    fixtures: &mut Vec<Fixture>,
    measurements: &mut Vec<Measurement>,
) -> Result<(), String> {
    let root = workdir.join("files");
    let data = root.join("data");
    fs::create_dir_all(root.join(".edgefossil")).map_err(|error| error.to_string())?;
    fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    for index in 0..profile.files {
        let directory = data.join(format!("d{:03}", index / 100));
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        fs::write(
            directory.join(format!("f{index:05}.txt")),
            format!("edgefoss baseline file {index:05}\n"),
        )
        .map_err(|error| error.to_string())?;
    }
    let signing_key = SigningKey::from_bytes(&[0x31; 32]);
    let genesis = ProjectGenesis {
        name: "G2 file baseline".into(),
        nonce: [0x41; 32],
        actor_key: signing_key.verifying_key().to_bytes(),
        created_at: "2026-08-25T00:00:00Z".into(),
    };
    let database = root.join(".edgefossil/repository.sqlite3");
    let mut repository = LocalRepository::open(&database).map_err(|error| error.to_string())?;
    repository
        .init_project(&genesis)
        .map_err(|error| error.to_string())?;
    repository
        .set_tracking_rule(
            &TrackingRule::new(
                "data",
                TrackingScope::Prefix,
                TrackingMode::Project,
                Some(Realm::Public),
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    drop(repository);
    let snapshot_arguments = vec![
        "snapshot".into(),
        "--path".into(),
        root.display().to_string(),
    ];
    let mut snapshot_times = vec![run_ef(ef, &snapshot_arguments)?];
    let mut repository = LocalRepository::open(&database).map_err(|error| error.to_string())?;
    commit_current_public(&mut repository, &signing_key)?;
    drop(repository);
    for _ in 1..profile.light_repetitions {
        snapshot_times.push(run_ef(ef, &snapshot_arguments)?);
    }
    record(measurements, "files", "ef snapshot", snapshot_times);
    for (label, arguments) in [
        ("ef status", vec!["status", "--path"]),
        (
            "ef history --realm public --limit 20",
            vec!["history", "--realm", "public", "--limit", "20", "--path"],
        ),
        (
            "ef diff --realm public",
            vec!["diff", "--realm", "public", "--path"],
        ),
    ] {
        let mut arguments = arguments.into_iter().map(String::from).collect::<Vec<_>>();
        arguments.push(root.display().to_string());
        record(
            measurements,
            "files",
            label,
            repeated_ef(ef, &arguments, profile.light_repetitions)?,
        );
    }
    let mut export_times = Vec::new();
    for repetition in 0..profile.export_repetitions {
        let destination = workdir.join(format!("files-export-{repetition}.edge"));
        export_times.push(run_ef(
            ef,
            &[
                "export".into(),
                "--realm".into(),
                "public".into(),
                "--output".into(),
                destination.display().to_string(),
                "--path".into(),
                root.display().to_string(),
            ],
        )?);
        fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }
    record(
        measurements,
        "files",
        "ef export --realm public",
        export_times,
    );
    fixtures.push(Fixture {
        name: "files",
        files: profile.files,
        artifacts: artifact_count(&database)?,
        realms: 1,
    });
    Ok(())
}

fn commit_current_public(
    repository: &mut LocalRepository,
    signing_key: &SigningKey,
) -> Result<(), String> {
    let basis = repository
        .checkpoint_basis(Realm::Public)
        .map_err(|error| error.to_string())?;
    let change = ChangeArtifact {
        meta: ArtifactMeta {
            project: basis.project.clone(),
            realm: Realm::Public,
            parents: Vec::new(),
            actor_key: basis.actor_key,
            logical_clock: 0,
            created_at: "2026-08-25T00:00:01Z".into(),
        },
        root: basis.root.clone(),
        message: "G2 file fixture".into(),
    };
    let change_id = artifact_id(&encode_change(&change).map_err(|error| error.to_string())?);
    let signatures = basis
        .artifacts_to_sign
        .iter()
        .chain(std::iter::once(&change_id))
        .map(|id| sign(signing_key, id))
        .collect::<Result<Vec<_>, String>>()?;
    repository
        .commit_checkpoint(&change, 0, &signatures)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn sign(signing_key: &SigningKey, artifact: &str) -> Result<SignatureRecord, String> {
    let message = artifact_signature_message(artifact).map_err(|error| error.to_string())?;
    Ok(SignatureRecord {
        artifact: artifact.into(),
        actor_key: signing_key.verifying_key().to_bytes(),
        signature: signing_key.sign(&message).to_bytes(),
    })
}

#[allow(clippy::too_many_lines)]
fn build_artifact_fixture(
    profile: Profile,
    ef: &Path,
    workdir: &Path,
    fixtures: &mut Vec<Fixture>,
    measurements: &mut Vec<Measurement>,
) -> Result<(), String> {
    let root = workdir.join("artifacts");
    fs::create_dir_all(root.join(".edgefossil")).map_err(|error| error.to_string())?;
    let database = root.join(".edgefossil/repository.sqlite3");
    let signing_key = SigningKey::from_bytes(&[0x32; 32]);
    let genesis = ProjectGenesis {
        name: "G2 artifact baseline".into(),
        nonce: [0x42; 32],
        actor_key: signing_key.verifying_key().to_bytes(),
        created_at: "2026-08-25T00:00:00Z".into(),
    };
    let public = synthetic_bundle(
        &genesis,
        &signing_key,
        Realm::Public,
        profile.changes_per_realm,
        &[],
    )?;
    let project = public.manifest.project.clone();
    let verified_public = verify_portable_bundle(&public.manifest_bytes, &public.objects, &[])
        .map_err(|error| error.to_string())?;
    let mut repository = LocalRepository::open(&database).map_err(|error| error.to_string())?;
    repository
        .import_bundle(&public.manifest_bytes, &public.objects, &[])
        .map_err(|error| error.to_string())?;
    drop(public);
    let public_base = vec![(Realm::Public, verified_public.semantic_root().to_owned())];
    let members = synthetic_bundle(
        &genesis,
        &signing_key,
        Realm::Members,
        profile.changes_per_realm,
        &public_base,
    )?;
    let verified_members = verify_portable_bundle(
        &members.manifest_bytes,
        &members.objects,
        std::slice::from_ref(&verified_public),
    )
    .map_err(|error| error.to_string())?;
    repository
        .import_bundle(
            &members.manifest_bytes,
            &members.objects,
            std::slice::from_ref(&verified_public),
        )
        .map_err(|error| error.to_string())?;
    drop(members);
    let local_bases = vec![
        (Realm::Public, verified_public.semantic_root().to_owned()),
        (Realm::Members, verified_members.semantic_root().to_owned()),
    ];
    let local = synthetic_bundle(
        &genesis,
        &signing_key,
        Realm::Local,
        profile.changes_per_realm,
        &local_bases,
    )?;
    repository
        .import_bundle(
            &local.manifest_bytes,
            &local.objects,
            &[verified_public, verified_members],
        )
        .map_err(|error| error.to_string())?;
    drop(local);
    let working_inputs = (0..profile.files)
        .map(|index| SnapshotInput {
            path: format!("g{:03}/w{index:05}/a/b/c/d/e/file.txt", index / 100),
            realm: Realm::Public,
            kind: SnapshotInputKind::File {
                bytes: format!("working artifact {index:05}\n").into_bytes(),
                executable: false,
            },
        })
        .collect::<Vec<_>>();
    let working = build_realm_snapshots(
        &project,
        genesis.actor_key,
        &genesis.created_at,
        &working_inputs,
    )
    .map_err(|error| error.to_string())?;
    repository
        .replace_working_snapshots(&working, "2026-08-25T00:00:02Z")
        .map_err(|error| error.to_string())?;
    drop(repository);
    let artifacts = artifact_count(&database)?;
    if profile.name == "g2" && artifacts < 100_000 {
        return Err(format!(
            "g2 artifact fixture contains only {artifacts} artifacts"
        ));
    }
    fixtures.push(Fixture {
        name: "artifacts",
        files: 0,
        artifacts,
        realms: 3,
    });
    for (label, arguments) in [
        ("ef status", vec!["status", "--path"]),
        (
            "ef history --realm public --limit 20",
            vec!["history", "--realm", "public", "--limit", "20", "--path"],
        ),
        (
            "ef history --realm members --limit 20",
            vec!["history", "--realm", "members", "--limit", "20", "--path"],
        ),
        (
            "ef history --realm local --limit 20",
            vec!["history", "--realm", "local", "--limit", "20", "--path"],
        ),
    ] {
        let mut arguments = arguments.into_iter().map(String::from).collect::<Vec<_>>();
        arguments.push(root.display().to_string());
        record(
            measurements,
            "artifacts",
            label,
            repeated_ef(ef, &arguments, profile.light_repetitions)?,
        );
    }
    for repetition in 0..profile.export_repetitions {
        let public = workdir.join(format!("artifacts-public-{repetition}.edge"));
        let members = workdir.join(format!("artifacts-members-{repetition}.edge"));
        let local = workdir.join(format!("artifacts-local-{repetition}.edge"));
        let public_times = vec![run_ef(
            ef,
            &[
                "export".into(),
                "--realm".into(),
                "public".into(),
                "--output".into(),
                public.display().to_string(),
                "--path".into(),
                root.display().to_string(),
            ],
        )?];
        record(
            measurements,
            "artifacts",
            "ef export --realm public",
            public_times,
        );
        let members_times = vec![run_ef(
            ef,
            &[
                "export".into(),
                "--realm".into(),
                "members".into(),
                "--base".into(),
                format!("public={}", public.display()),
                "--output".into(),
                members.display().to_string(),
                "--path".into(),
                root.display().to_string(),
            ],
        )?];
        record(
            measurements,
            "artifacts",
            "ef export --realm members",
            members_times,
        );
        let local_times = vec![run_ef(
            ef,
            &[
                "export".into(),
                "--realm".into(),
                "local".into(),
                "--base".into(),
                format!("public={}", public.display()),
                "--base".into(),
                format!("members={}", members.display()),
                "--output".into(),
                local.display().to_string(),
                "--path".into(),
                root.display().to_string(),
            ],
        )?];
        record(
            measurements,
            "artifacts",
            "ef export --realm local",
            local_times,
        );
        fs::remove_dir_all(public).map_err(|error| error.to_string())?;
        fs::remove_dir_all(members).map_err(|error| error.to_string())?;
        fs::remove_dir_all(local).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn synthetic_bundle(
    genesis: &ProjectGenesis,
    signing_key: &SigningKey,
    realm: Realm,
    changes: usize,
    base_roots: &[(Realm, String)],
) -> Result<PortableBundle, String> {
    let genesis_body = encode_project_genesis(genesis).map_err(|error| error.to_string())?;
    let project = artifact_id(&genesis_body);
    let tree = TreeArtifact {
        meta: ArtifactMeta {
            project: project.clone(),
            realm,
            parents: Vec::new(),
            actor_key: genesis.actor_key,
            logical_clock: 0,
            created_at: genesis.created_at.clone(),
        },
        entries: Vec::new(),
    };
    let tree_body = encode_tree(&tree).map_err(|error| error.to_string())?;
    let tree_id = artifact_id(&tree_body);
    let mut artifacts = BTreeMap::new();
    if realm == Realm::Public {
        artifacts.insert(project.clone(), genesis_body);
    }
    artifacts.insert(tree_id.clone(), tree_body);
    let mut parent = None;
    for clock in 0..changes {
        let change = ChangeArtifact {
            meta: ArtifactMeta {
                project: project.clone(),
                realm,
                parents: parent.clone().into_iter().collect(),
                actor_key: genesis.actor_key,
                logical_clock: u64::try_from(clock).map_err(|error| error.to_string())?,
                created_at: genesis.created_at.clone(),
            },
            root: tree_id.clone(),
            message: format!("synthetic change {clock}"),
        };
        let body = encode_change(&change).map_err(|error| error.to_string())?;
        let id = artifact_id(&body);
        artifacts.insert(id.clone(), body);
        parent = Some(id);
    }
    let head = parent.ok_or("synthetic bundle needs at least one change")?;
    let mut signatures = BTreeMap::new();
    for id in artifacts.keys() {
        let record = sign(signing_key, id)?;
        let body = encode_signature_record(&record).map_err(|error| error.to_string())?;
        signatures.insert(artifact_id(&body), body);
    }
    let artifact_ids = artifacts.keys().cloned().collect::<Vec<_>>();
    let refs: Vec<(String, String)> = vec![(CHECKPOINT_REF.into(), head)];
    let semantic_root = compute_semantic_root(&SemanticRootInput {
        project: project.clone(),
        realm,
        artifacts: artifact_ids
            .iter()
            .cloned()
            .map(|id| SemanticArtifact { id, realm })
            .collect(),
        refs: refs
            .iter()
            .map(|(name, target)| SemanticRef {
                name: name.clone(),
                target: target.clone(),
                realm,
            })
            .collect(),
        policy_version: 0,
    })
    .map_err(|error| error.to_string())?
    .semantic_root;
    let manifest = BundleManifest {
        project,
        realm,
        policy_version: 0,
        semantic_root,
        artifacts: artifact_ids,
        blobs: Vec::new(),
        signatures: signatures.keys().cloned().collect(),
        refs,
        base_roots: base_roots.to_vec(),
    };
    let manifest_bytes = encode_bundle_manifest(&manifest).map_err(|error| error.to_string())?;
    let mut objects = BTreeMap::new();
    for (kind, values) in [("artifacts", artifacts), ("signatures", signatures)] {
        for (id, body) in values {
            objects.insert(format!("{kind}/{}.cbor", &id[7..]), body);
        }
    }
    Ok(PortableBundle {
        manifest,
        manifest_bytes,
        objects,
    })
}

#[cfg(test)]
mod tests {
    use super::{Profile, synthetic_bundle};
    use ed25519_dalek::SigningKey;
    use ef_format::{ProjectGenesis, Realm};
    use ef_store_sqlite::{LocalRepository, verify_portable_bundle};

    #[test]
    fn synthetic_two_realm_fixture_restores_exact_generations() {
        let profile = Profile::parse("smoke").unwrap();
        let signing_key = SigningKey::from_bytes(&[0x32; 32]);
        let genesis = ProjectGenesis {
            name: "testkit smoke".into(),
            nonce: [0x52; 32],
            actor_key: signing_key.verifying_key().to_bytes(),
            created_at: "2026-08-25T00:00:00Z".into(),
        };
        let public = synthetic_bundle(
            &genesis,
            &signing_key,
            Realm::Public,
            profile.changes_per_realm,
            &[],
        )
        .unwrap();
        let verified =
            verify_portable_bundle(&public.manifest_bytes, &public.objects, &[]).unwrap();
        let bases = vec![(Realm::Public, verified.semantic_root().to_owned())];
        let members = synthetic_bundle(
            &genesis,
            &signing_key,
            Realm::Members,
            profile.changes_per_realm,
            &bases,
        )
        .unwrap();
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let public_result = repository
            .import_bundle(&public.manifest_bytes, &public.objects, &[])
            .unwrap();
        let members_result = repository
            .import_bundle(
                &members.manifest_bytes,
                &members.objects,
                std::slice::from_ref(&verified),
            )
            .unwrap();
        assert_eq!(public_result.generation, 50);
        assert_eq!(members_result.generation, 50);
        assert_eq!(repository.checkpoint_heads().unwrap().len(), 2);
    }
}
