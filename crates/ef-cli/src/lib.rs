//! Local `EdgeFossil` command-line workflows.

use std::fmt::Write as _;
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    ffi::{OsStr, OsString},
    fmt, fs,
    fs::{File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use ed25519_dalek::{Signer, SigningKey};
use edgefoss_core::{SnapshotInput, SnapshotInputKind, build_realm_snapshots};
use ef_format::{
    ArtifactMeta, ChangeArtifact, ProjectGenesis, Realm, SignatureRecord, TreeEntryMode,
    artifact_id, artifact_signature_message, decode_bundle_manifest, encode_change,
    encode_project_genesis, validate_path,
};
use ef_static_site::build_public_site;
use ef_store_sqlite::{
    DiffKind, LocalRepository, TrackingMode, TrackingRule, TrackingScope, verify_portable_bundle,
};
use zeroize::Zeroizing;

const METADATA_DIRECTORY: &str = ".edgefossil";
const DATABASE_FILE: &str = "repository.sqlite3";
const MAX_SNAPSHOT_BLOB_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BUNDLE_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BUNDLE_OBJECT_BYTES: u64 = 16 * 1024 * 1024;
type BundleObjects = BTreeMap<String, Vec<u8>>;
const HELP: &str = "EdgeFossil local repository CLI

Usage:
  ef keygen --output <KEY_FILE>
  ef init --name <NAME> --actor-key <64 LOWERCASE HEX> [--path <DIRECTORY>]
  ef track [--local | --none | --realm <public|members>] [--path <DIRECTORY>] <TARGET>
  ef snapshot [--path <DIRECTORY>]
  ef checkpoint --realm <public|members|local> -m <MESSAGE> --signing-key-file <KEY_FILE> [--path <DIRECTORY>]
  ef history --realm <public|members|local> [--limit <1..1000>] [--path <DIRECTORY>]
  ef diff --realm <public|members|local> [--path <DIRECTORY>]
  ef export --realm <public|members|local> --output <BUNDLE_DIRECTORY> [--base <REALM=BUNDLE_DIRECTORY>]... [--path <DIRECTORY>]
  ef verify <BUNDLE_DIRECTORY> [--base <REALM=BUNDLE_DIRECTORY>]...
  ef import <BUNDLE_DIRECTORY> [--base <REALM=BUNDLE_DIRECTORY>]... [--path <DIRECTORY>]
  ef static-build <PUBLIC_BUNDLE_DIRECTORY> --output <SITE_DIRECTORY>
  ef status [--path <DIRECTORY>] [--explain <TARGET>]
  ef --help
  ef --version

The actor key is an Ed25519 public key. Signing-key files must stay outside the
repository and are never copied into its database or artifacts.";

/// A user-facing command-line failure.
#[derive(Debug)]
pub struct CliError(String);

impl CliError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for CliError {}

/// Runs the CLI with an argument sequence including the executable name.
///
/// # Errors
///
/// Returns a descriptive error for invalid arguments, unsafe repository paths,
/// invalid genesis input, random-source failure, or local storage failure.
pub fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<(), CliError> {
    let mut arguments = arguments.into_iter();
    let _executable = arguments.next();
    let Some(command) = arguments.next() else {
        println!("{HELP}");
        return Ok(());
    };

    match command.to_str() {
        Some("keygen") => run_keygen(&parse_keygen(arguments)?),
        Some("init") => run_init(parse_init(arguments)?),
        Some("track") => run_track(&parse_track(arguments)?),
        Some("snapshot") => run_snapshot(&parse_snapshot(arguments)?),
        Some("checkpoint") => run_checkpoint(&parse_checkpoint(arguments)?),
        Some("history") => run_history(&parse_history(arguments)?),
        Some("diff") => run_diff(&parse_diff(arguments)?),
        Some("export") => run_export(&parse_export(arguments)?),
        Some("verify") => run_verify(&parse_verify(arguments)?),
        Some("import") => run_import(&parse_import(arguments)?),
        Some("static-build") => run_static_build(&parse_static_build(arguments)?),
        Some("status") => run_status(&parse_status(arguments)?),
        Some("--help" | "-h" | "help") => {
            reject_trailing(arguments)?;
            println!("{HELP}");
            Ok(())
        }
        Some("--version" | "-V") => {
            reject_trailing(arguments)?;
            println!("ef {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(other) => Err(CliError::new(format!(
            "unknown command or option `{other}`"
        ))),
        None => Err(CliError::new("command must be valid UTF-8")),
    }
}

struct InitOptions {
    name: String,
    actor_key: [u8; 32],
    path: PathBuf,
}

struct StatusOptions {
    path: PathBuf,
    explain: Option<OsString>,
}

struct TrackOptions {
    path: PathBuf,
    target: OsString,
    selection: TrackSelection,
}

struct SnapshotOptions {
    path: PathBuf,
}

struct KeygenOptions {
    output: PathBuf,
}

struct CheckpointOptions {
    path: PathBuf,
    realm: Realm,
    message: String,
    signing_key_file: PathBuf,
}

struct HistoryOptions {
    path: PathBuf,
    realm: Realm,
    limit: usize,
}

struct DiffOptions {
    path: PathBuf,
    realm: Realm,
}

struct ExportOptions {
    path: PathBuf,
    realm: Realm,
    output: PathBuf,
    bases: Vec<BundleBaseOption>,
}

struct VerifyOptions {
    bundle: PathBuf,
    bases: Vec<BundleBaseOption>,
}

struct ImportOptions {
    path: PathBuf,
    bundle: PathBuf,
    bases: Vec<BundleBaseOption>,
}

struct StaticBuildOptions {
    bundle: PathBuf,
    output: PathBuf,
}

struct BundleBaseOption {
    realm: Realm,
    path: PathBuf,
}

#[derive(Clone, Copy)]
enum TrackSelection {
    None,
    Local,
    Project(Realm),
}

fn parse_init(arguments: impl Iterator<Item = OsString>) -> Result<InitOptions, CliError> {
    let mut name = None;
    let mut actor_key = None;
    let mut path = None;
    let mut arguments = arguments.peekable();

    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--name") => set_once(
                &mut name,
                parse_utf8_value(&mut arguments, "--name")?,
                "--name",
            )?,
            Some("--actor-key") => set_once(
                &mut actor_key,
                parse_actor_key(&parse_utf8_value(&mut arguments, "--actor-key")?)?,
                "--actor-key",
            )?,
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some(other) => return Err(CliError::new(format!("unknown init option `{other}`"))),
            None => return Err(CliError::new("init option must be valid UTF-8")),
        }
    }

    Ok(InitOptions {
        name: name.ok_or_else(|| CliError::new("missing required option --name"))?,
        actor_key: actor_key.ok_or_else(|| CliError::new("missing required option --actor-key"))?,
        path: path.unwrap_or_else(|| PathBuf::from(".")),
    })
}

fn parse_keygen(arguments: impl Iterator<Item = OsString>) -> Result<KeygenOptions, CliError> {
    let mut output = None;
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--output") => set_once(
                &mut output,
                PathBuf::from(parse_value(&mut arguments, "--output")?),
                "--output",
            )?,
            Some(other) => return Err(CliError::new(format!("unknown keygen option `{other}`"))),
            None => return Err(CliError::new("keygen option must be valid UTF-8")),
        }
    }
    Ok(KeygenOptions {
        output: output.ok_or_else(|| CliError::new("missing required option --output"))?,
    })
}

fn parse_status(arguments: impl Iterator<Item = OsString>) -> Result<StatusOptions, CliError> {
    let mut path = None;
    let mut explain = None;
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some("--explain") => set_once(
                &mut explain,
                parse_value(&mut arguments, "--explain")?,
                "--explain",
            )?,
            Some(other) => return Err(CliError::new(format!("unknown status option `{other}`"))),
            None => return Err(CliError::new("status option must be valid UTF-8")),
        }
    }
    Ok(StatusOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
        explain,
    })
}

fn parse_track(arguments: impl Iterator<Item = OsString>) -> Result<TrackOptions, CliError> {
    let mut path = None;
    let mut target = None;
    let mut selection = None;
    let mut arguments = arguments.peekable();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some("--local") => {
                set_tracking_selection(&mut selection, TrackSelection::Local, "--local")?;
            }
            Some("--none") => {
                set_tracking_selection(&mut selection, TrackSelection::None, "--none")?;
            }
            Some("--realm") => {
                let realm = parse_project_realm(&parse_utf8_value(&mut arguments, "--realm")?)?;
                set_tracking_selection(&mut selection, TrackSelection::Project(realm), "--realm")?;
            }
            Some(value) if value.starts_with('-') => {
                return Err(CliError::new(format!("unknown track option `{value}`")));
            }
            _ => set_once(&mut target, argument, "TARGET")?,
        }
    }
    Ok(TrackOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
        target: target.ok_or_else(|| CliError::new("missing required TARGET"))?,
        selection: selection.unwrap_or(TrackSelection::Project(Realm::Public)),
    })
}

fn parse_snapshot(arguments: impl Iterator<Item = OsString>) -> Result<SnapshotOptions, CliError> {
    let mut path = None;
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some(other) => return Err(CliError::new(format!("unknown snapshot option `{other}`"))),
            None => return Err(CliError::new("snapshot option must be valid UTF-8")),
        }
    }
    Ok(SnapshotOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
    })
}

fn parse_checkpoint(
    arguments: impl Iterator<Item = OsString>,
) -> Result<CheckpointOptions, CliError> {
    let mut path = None;
    let mut realm = None;
    let mut message = None;
    let mut signing_key_file = None;
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some("--realm") => set_once(
                &mut realm,
                parse_checkpoint_realm(&parse_utf8_value(&mut arguments, "--realm")?)?,
                "--realm",
            )?,
            Some("-m" | "--message") => set_once(
                &mut message,
                parse_utf8_value(&mut arguments, "-m/--message")?,
                "-m/--message",
            )?,
            Some("--signing-key-file") => set_once(
                &mut signing_key_file,
                PathBuf::from(parse_value(&mut arguments, "--signing-key-file")?),
                "--signing-key-file",
            )?,
            Some(other) => {
                return Err(CliError::new(format!(
                    "unknown checkpoint option `{other}`"
                )));
            }
            None => return Err(CliError::new("checkpoint option must be valid UTF-8")),
        }
    }
    Ok(CheckpointOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
        realm: realm.ok_or_else(|| CliError::new("missing required option --realm"))?,
        message: message.ok_or_else(|| CliError::new("missing required option -m/--message"))?,
        signing_key_file: signing_key_file
            .ok_or_else(|| CliError::new("missing required option --signing-key-file"))?,
    })
}

fn parse_history(arguments: impl Iterator<Item = OsString>) -> Result<HistoryOptions, CliError> {
    let mut path = None;
    let mut realm = None;
    let mut limit = None;
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some("--realm") => set_once(
                &mut realm,
                parse_checkpoint_realm(&parse_utf8_value(&mut arguments, "--realm")?)?,
                "--realm",
            )?,
            Some("--limit") => {
                let value = parse_utf8_value(&mut arguments, "--limit")?;
                let value = value.parse::<usize>().map_err(|_| {
                    CliError::new("--limit must be a decimal integer between 1 and 1000")
                })?;
                if !(1..=1_000).contains(&value) {
                    return Err(CliError::new(
                        "--limit must be a decimal integer between 1 and 1000",
                    ));
                }
                set_once(&mut limit, value, "--limit")?;
            }
            Some(other) => return Err(CliError::new(format!("unknown history option `{other}`"))),
            None => return Err(CliError::new("history option must be valid UTF-8")),
        }
    }
    Ok(HistoryOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
        realm: realm.ok_or_else(|| CliError::new("missing required option --realm"))?,
        limit: limit.unwrap_or(20),
    })
}

fn parse_diff(arguments: impl Iterator<Item = OsString>) -> Result<DiffOptions, CliError> {
    let mut path = None;
    let mut realm = None;
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some("--realm") => set_once(
                &mut realm,
                parse_checkpoint_realm(&parse_utf8_value(&mut arguments, "--realm")?)?,
                "--realm",
            )?,
            Some(other) => return Err(CliError::new(format!("unknown diff option `{other}`"))),
            None => return Err(CliError::new("diff option must be valid UTF-8")),
        }
    }
    Ok(DiffOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
        realm: realm.ok_or_else(|| CliError::new("missing required option --realm"))?,
    })
}

fn parse_export(arguments: impl Iterator<Item = OsString>) -> Result<ExportOptions, CliError> {
    let mut path = None;
    let mut realm = None;
    let mut output = None;
    let mut bases = Vec::new();
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some("--realm") => set_once(
                &mut realm,
                parse_checkpoint_realm(&parse_utf8_value(&mut arguments, "--realm")?)?,
                "--realm",
            )?,
            Some("--output") => set_once(
                &mut output,
                PathBuf::from(parse_value(&mut arguments, "--output")?),
                "--output",
            )?,
            Some("--base") => {
                let value = parse_utf8_value(&mut arguments, "--base")?;
                push_bundle_base(&mut bases, &value)?;
            }
            Some(other) => return Err(CliError::new(format!("unknown export option `{other}`"))),
            None => return Err(CliError::new("export option must be valid UTF-8")),
        }
    }
    Ok(ExportOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
        realm: realm.ok_or_else(|| CliError::new("missing required option --realm"))?,
        output: output.ok_or_else(|| CliError::new("missing required option --output"))?,
        bases,
    })
}

fn parse_verify(arguments: impl Iterator<Item = OsString>) -> Result<VerifyOptions, CliError> {
    let mut bundle = None;
    let mut bases = Vec::new();
    let mut arguments = arguments.peekable();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--base") => {
                let value = parse_utf8_value(&mut arguments, "--base")?;
                push_bundle_base(&mut bases, &value)?;
            }
            Some(value) if value.starts_with('-') => {
                return Err(CliError::new(format!("unknown verify option `{value}`")));
            }
            _ => set_once(&mut bundle, PathBuf::from(argument), "BUNDLE_DIRECTORY")?,
        }
    }
    Ok(VerifyOptions {
        bundle: bundle.ok_or_else(|| CliError::new("missing required BUNDLE_DIRECTORY"))?,
        bases,
    })
}

fn parse_import(arguments: impl Iterator<Item = OsString>) -> Result<ImportOptions, CliError> {
    let mut path = None;
    let mut bundle = None;
    let mut bases = Vec::new();
    let mut arguments = arguments.peekable();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some("--base") => {
                let value = parse_utf8_value(&mut arguments, "--base")?;
                push_bundle_base(&mut bases, &value)?;
            }
            Some(value) if value.starts_with('-') => {
                return Err(CliError::new(format!("unknown import option `{value}`")));
            }
            _ => set_once(&mut bundle, PathBuf::from(argument), "BUNDLE_DIRECTORY")?,
        }
    }
    Ok(ImportOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
        bundle: bundle.ok_or_else(|| CliError::new("missing required BUNDLE_DIRECTORY"))?,
        bases,
    })
}

fn parse_static_build(
    arguments: impl Iterator<Item = OsString>,
) -> Result<StaticBuildOptions, CliError> {
    let mut bundle = None;
    let mut output = None;
    let mut arguments = arguments.peekable();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--output") => set_once(
                &mut output,
                PathBuf::from(parse_value(&mut arguments, "--output")?),
                "--output",
            )?,
            Some(value) if value.starts_with('-') => {
                return Err(CliError::new(format!(
                    "unknown static-build option `{value}`"
                )));
            }
            _ => set_once(
                &mut bundle,
                PathBuf::from(argument),
                "PUBLIC_BUNDLE_DIRECTORY",
            )?,
        }
    }
    Ok(StaticBuildOptions {
        bundle: bundle.ok_or_else(|| CliError::new("missing required PUBLIC_BUNDLE_DIRECTORY"))?,
        output: output.ok_or_else(|| CliError::new("missing required option --output"))?,
    })
}

fn push_bundle_base(bases: &mut Vec<BundleBaseOption>, value: &str) -> Result<(), CliError> {
    let (realm, path) = value
        .split_once('=')
        .ok_or_else(|| CliError::new("--base must be REALM=BUNDLE_DIRECTORY"))?;
    let realm = match realm {
        "public" => Realm::Public,
        "members" => Realm::Members,
        _ => {
            return Err(CliError::new("--base realm must be `public` or `members`"));
        }
    };
    if path.is_empty() {
        return Err(CliError::new("--base bundle directory must not be empty"));
    }
    if bases.iter().any(|base| base.realm == realm) {
        return Err(CliError::new(format!(
            "--base {} was provided twice",
            realm.as_str()
        )));
    }
    bases.push(BundleBaseOption {
        realm,
        path: PathBuf::from(path),
    });
    Ok(())
}

fn set_tracking_selection(
    selection: &mut Option<TrackSelection>,
    value: TrackSelection,
    option: &str,
) -> Result<(), CliError> {
    if selection.replace(value).is_some() {
        return Err(CliError::new(format!(
            "{option} conflicts with another tracking destination"
        )));
    }
    Ok(())
}

fn parse_project_realm(value: &str) -> Result<Realm, CliError> {
    match value {
        "public" => Ok(Realm::Public),
        "members" => Ok(Realm::Members),
        _ => Err(CliError::new(
            "--realm must be `public` or `members`; use --local for local history",
        )),
    }
}

fn parse_checkpoint_realm(value: &str) -> Result<Realm, CliError> {
    match value {
        "public" => Ok(Realm::Public),
        "members" => Ok(Realm::Members),
        "local" => Ok(Realm::Local),
        _ => Err(CliError::new(
            "--realm must be `public`, `members`, or `local`",
        )),
    }
}

fn parse_value(
    arguments: &mut impl Iterator<Item = OsString>,
    option: &str,
) -> Result<OsString, CliError> {
    arguments
        .next()
        .ok_or_else(|| CliError::new(format!("missing value for {option}")))
}

fn parse_utf8_value(
    arguments: &mut impl Iterator<Item = OsString>,
    option: &str,
) -> Result<String, CliError> {
    parse_value(arguments, option)?
        .into_string()
        .map_err(|_| CliError::new(format!("value for {option} must be valid UTF-8")))
}

fn set_once<T>(slot: &mut Option<T>, value: T, option: &str) -> Result<(), CliError> {
    if slot.replace(value).is_some() {
        return Err(CliError::new(format!("option {option} was provided twice")));
    }
    Ok(())
}

fn reject_trailing(mut arguments: impl Iterator<Item = OsString>) -> Result<(), CliError> {
    if let Some(argument) = arguments.next() {
        return Err(CliError::new(format!(
            "unexpected argument `{}`",
            argument.to_string_lossy()
        )));
    }
    Ok(())
}

fn parse_actor_key(value: &str) -> Result<[u8; 32], CliError> {
    if value.len() != 64
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(CliError::new(
            "--actor-key must be exactly 64 lowercase hexadecimal characters",
        ));
    }
    let mut key = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        key[index] = (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]);
    }
    Ok(key)
}

const fn hex_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        _ => unreachable!(),
    }
}

fn run_init(options: InitOptions) -> Result<(), CliError> {
    let root = canonical_directory(&options.path)?;
    let metadata_path = root.join(METADATA_DIRECTORY);
    let database_path = metadata_path.join(DATABASE_FILE);
    reject_symlink_if_present(&metadata_path, "repository metadata directory")?;
    reject_symlink_if_present(&database_path, "repository database")?;

    if database_path.exists() {
        let repository = open_repository(&database_path)?;
        if repository
            .project_id()
            .map_err(|error| CliError::new(error.to_string()))?
            .is_some()
        {
            return Err(CliError::new(format!(
                "repository is already initialized at {}",
                root.display()
            )));
        }
    }

    let mut nonce = [0_u8; 32];
    getrandom::fill(&mut nonce)
        .map_err(|error| CliError::new(format!("OS random source failed: {error}")))?;
    let genesis = ProjectGenesis {
        name: options.name,
        nonce,
        actor_key: options.actor_key,
        created_at: current_timestamp()?,
    };
    encode_project_genesis(&genesis)
        .map_err(|error| CliError::new(format!("invalid project genesis: {error}")))?;

    if !metadata_path.exists() {
        create_metadata_directory(&metadata_path)?;
    } else if !metadata_path.is_dir() {
        return Err(CliError::new(format!(
            "repository metadata path is not a directory: {}",
            metadata_path.display()
        )));
    }

    if !database_path.exists() {
        create_database_file(&database_path)?;
    }

    let mut repository = open_repository(&database_path)?;
    let project_id = repository
        .init_project(&genesis)
        .map_err(|error| CliError::new(error.to_string()))?;
    println!("initialized: {project_id}");
    println!("repository: {}", root.display());
    Ok(())
}

fn run_keygen(options: &KeygenOptions) -> Result<(), CliError> {
    let output = canonical_new_file_path(&options.output)?;
    reject_symlink_if_present(&output, "signing key file")?;
    let mut seed = Zeroizing::new([0_u8; 32]);
    getrandom::fill(&mut *seed)
        .map_err(|error| CliError::new(format!("OS random source failed: {error}")))?;
    let signing_key = SigningKey::from_bytes(&seed);

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&output)
        .map_err(|error| CliError::new(format!("cannot create {}: {error}", output.display())))?;
    let write_result = (|| -> std::io::Result<()> {
        let encoded = encode_secret_seed(&seed);
        file.write_all(&encoded)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        drop(file);
        let _ = fs::remove_file(&output);
        return Err(CliError::new(format!(
            "cannot write {}: {error}",
            output.display()
        )));
    }
    println!(
        "actor-key: {}",
        encode_public_key(&signing_key.verifying_key().to_bytes())
    );
    println!("signing-key-file: {}", output.display());
    Ok(())
}

fn run_checkpoint(options: &CheckpointOptions) -> Result<(), CliError> {
    let start = canonical_directory(&options.path)?;
    let root = find_repository_root(&start)?.ok_or_else(|| {
        CliError::new(format!(
            "no EdgeFossil repository found from {}",
            start.display()
        ))
    })?;
    let database_path = root.join(METADATA_DIRECTORY).join(DATABASE_FILE);
    let mut repository = open_repository(&database_path)?;
    let basis = repository
        .checkpoint_basis(options.realm)
        .map_err(|error| CliError::new(error.to_string()))?;
    let seed = read_signing_seed(&options.signing_key_file, &root)?;
    let signing_key = SigningKey::from_bytes(&seed);
    if signing_key.verifying_key().to_bytes() != basis.actor_key {
        return Err(CliError::new(
            "signing key does not match the repository genesis actor key",
        ));
    }
    let change = ChangeArtifact {
        meta: ArtifactMeta {
            project: basis.project,
            realm: basis.realm,
            parents: basis.parent.into_iter().collect(),
            actor_key: basis.actor_key,
            logical_clock: basis.logical_clock,
            created_at: current_timestamp()?,
        },
        root: basis.root,
        message: options.message.clone(),
    };
    let change_body = encode_change(&change)
        .map_err(|error| CliError::new(format!("invalid checkpoint change: {error}")))?;
    let change_id = artifact_id(&change_body);
    let mut artifact_ids = basis.artifacts_to_sign;
    artifact_ids.push(change_id);
    artifact_ids.sort();
    artifact_ids.dedup();
    let signatures = artifact_ids
        .iter()
        .map(|id| sign_artifact(&signing_key, id))
        .collect::<Result<Vec<_>, _>>()?;
    let result = repository
        .commit_checkpoint(&change, basis.expected_generation, &signatures)
        .map_err(|error| CliError::new(error.to_string()))?;
    println!("checkpoint-{}: {}", options.realm.as_str(), result.change);
    println!("root-{}: {}", options.realm.as_str(), change.root);
    println!("ref: heads/main");
    println!("generation: {}", result.generation);
    println!("signatures: {}", result.stored_signatures);
    Ok(())
}

fn run_history(options: &HistoryOptions) -> Result<(), CliError> {
    let start = canonical_directory(&options.path)?;
    let root = find_repository_root(&start)?.ok_or_else(|| {
        CliError::new(format!(
            "no EdgeFossil repository found from {}",
            start.display()
        ))
    })?;
    let repository = open_repository(&root.join(METADATA_DIRECTORY).join(DATABASE_FILE))?;
    let entries = repository
        .history(options.realm, options.limit)
        .map_err(|error| CliError::new(error.to_string()))?;
    println!("realm: {}", options.realm.as_str());
    println!("entries: {}", entries.len());
    for entry in entries {
        println!("change: {}", entry.id);
        println!("created-at: {}", entry.created_at);
        println!("logical-clock: {}", entry.logical_clock);
        println!("root: {}", entry.root);
        println!("parent: {}", entry.parent.as_deref().unwrap_or("-"));
        println!("message: {}", escape_terminal_text(&entry.message));
    }
    Ok(())
}

fn run_diff(options: &DiffOptions) -> Result<(), CliError> {
    let start = canonical_directory(&options.path)?;
    let root = find_repository_root(&start)?.ok_or_else(|| {
        CliError::new(format!(
            "no EdgeFossil repository found from {}",
            start.display()
        ))
    })?;
    let repository = open_repository(&root.join(METADATA_DIRECTORY).join(DATABASE_FILE))?;
    let entries = repository
        .working_diff(options.realm)
        .map_err(|error| CliError::new(error.to_string()))?;
    println!("realm: {}", options.realm.as_str());
    println!("changes: {}", entries.len());
    for entry in entries {
        let status = match entry.kind {
            DiffKind::Added => "A",
            DiffKind::Modified => "M",
            DiffKind::Deleted => "D",
        };
        let mode = match (entry.before, entry.after) {
            (Some(before), Some(after)) if before != after => {
                format!("{}->{}", tree_mode(before), tree_mode(after))
            }
            (_, Some(after)) => tree_mode(after).into(),
            (Some(before), None) => tree_mode(before).into(),
            (None, None) => return Err(CliError::new("diff entry has no path mode")),
        };
        println!("{status}\t{mode}\t{}", entry.path);
    }
    Ok(())
}

fn run_export(options: &ExportOptions) -> Result<(), CliError> {
    let start = canonical_directory(&options.path)?;
    let root = find_repository_root(&start)?.ok_or_else(|| {
        CliError::new(format!(
            "no EdgeFossil repository found from {}",
            start.display()
        ))
    })?;
    let output = canonical_new_directory_path(&options.output)?;
    reject_symlink_if_present(&output, "bundle output")?;
    if output.exists() {
        return Err(CliError::new(format!(
            "bundle output already exists: {}",
            output.display()
        )));
    }
    let verified_bases = verify_base_directories(options.realm, &options.bases)?;
    let base_roots = verified_bases
        .iter()
        .map(|base| (base.realm(), base.semantic_root().to_owned()))
        .collect::<Vec<_>>();
    let mut repository = open_repository(&root.join(METADATA_DIRECTORY).join(DATABASE_FILE))?;
    let bundle = repository
        .export_bundle(options.realm, &base_roots)
        .map_err(|error| CliError::new(error.to_string()))?;
    write_bundle_atomically(&output, &bundle.manifest_bytes, &bundle.objects)?;
    println!("bundle: {}", output.display());
    println!("project: {}", bundle.manifest.project);
    println!("realm: {}", bundle.manifest.realm.as_str());
    println!("semantic-root: {}", bundle.manifest.semantic_root);
    println!("artifacts: {}", bundle.manifest.artifacts.len());
    println!("blobs: {}", bundle.manifest.blobs.len());
    println!("signatures: {}", bundle.manifest.signatures.len());
    Ok(())
}

fn run_verify(options: &VerifyOptions) -> Result<(), CliError> {
    let root = canonical_bundle_directory(&options.bundle)?;
    let (manifest, objects) = read_bundle_directory(&root)?;
    let decoded = decode_bundle_manifest(&manifest)
        .map_err(|error| CliError::new(format!("invalid bundle manifest: {error}")))?;
    let bases = verify_base_directories(decoded.realm, &options.bases)?;
    let verified = verify_portable_bundle(&manifest, &objects, &bases)
        .map_err(|error| CliError::new(error.to_string()))?;
    println!("bundle: {}", root.display());
    println!("verification: ok");
    println!("project: {}", verified.project());
    println!("realm: {}", verified.realm().as_str());
    println!("semantic-root: {}", verified.semantic_root());
    println!("artifacts: {}", verified.artifact_count());
    println!("blobs: {}", verified.blob_count());
    println!("signatures: {}", verified.signature_count());
    println!("refs: {}", verified.ref_count());
    Ok(())
}

fn run_import(options: &ImportOptions) -> Result<(), CliError> {
    let bundle_root = canonical_bundle_directory(&options.bundle)?;
    let (manifest_bytes, objects) = read_bundle_directory(&bundle_root)?;
    let manifest = decode_bundle_manifest(&manifest_bytes)
        .map_err(|error| CliError::new(format!("invalid bundle manifest: {error}")))?;
    let bases = verify_base_directories(manifest.realm, &options.bases)?;
    verify_portable_bundle(&manifest_bytes, &objects, &bases)
        .map_err(|error| CliError::new(error.to_string()))?;

    let root = canonical_directory(&options.path)?;
    let metadata_path = root.join(METADATA_DIRECTORY);
    let database_path = metadata_path.join(DATABASE_FILE);
    reject_symlink_if_present(&metadata_path, "repository metadata directory")?;
    reject_symlink_if_present(&database_path, "repository database")?;
    let mut created_metadata = false;
    let mut created_database = false;
    if !metadata_path.exists() {
        create_metadata_directory(&metadata_path)?;
        created_metadata = true;
    } else if !metadata_path.is_dir() {
        return Err(CliError::new(format!(
            "repository metadata path is not a directory: {}",
            metadata_path.display()
        )));
    }
    if !database_path.exists() {
        if let Err(error) = create_database_file(&database_path) {
            if created_metadata {
                let _ = fs::remove_dir(&metadata_path);
            }
            return Err(error);
        }
        created_database = true;
    }

    let result = (|| -> Result<ef_store_sqlite::ImportResult, CliError> {
        let mut repository = open_repository(&database_path)?;
        repository
            .import_bundle(&manifest_bytes, &objects, &bases)
            .map_err(|error| CliError::new(error.to_string()))
    })();
    let imported = match result {
        Ok(imported) => imported,
        Err(error) => {
            if let Err(cleanup) = cleanup_failed_import(
                &metadata_path,
                &database_path,
                created_metadata,
                created_database,
            ) {
                return Err(CliError::new(format!(
                    "{error}; additionally, import cleanup failed: {cleanup}"
                )));
            }
            return Err(error);
        }
    };
    println!("repository: {}", root.display());
    println!("imported-project: {}", imported.project);
    println!("imported-realm: {}", imported.realm.as_str());
    println!("semantic-root: {}", imported.semantic_root);
    println!("generation: {}", imported.generation);
    Ok(())
}

fn run_static_build(options: &StaticBuildOptions) -> Result<(), CliError> {
    let bundle_root = canonical_bundle_directory(&options.bundle)?;
    let (manifest_bytes, objects) = read_bundle_directory(&bundle_root)?;
    let site = build_public_site(&manifest_bytes, &objects)
        .map_err(|error| CliError::new(error.to_string()))?;
    let output = canonical_new_directory_path(&options.output)?;
    reject_symlink_if_present(&output, "static site output")?;
    if output.exists() {
        return Err(CliError::new(format!(
            "static site output already exists: {}",
            output.display()
        )));
    }
    write_static_site_atomically(&output, &site.files)?;
    println!("site: {}", output.display());
    println!("project: {}", site.project);
    println!("realm: public");
    println!("semantic-root: {}", site.semantic_root);
    println!("assets: {}", site.files.len());
    Ok(())
}

fn cleanup_failed_import(
    metadata_path: &Path,
    database_path: &Path,
    created_metadata: bool,
    created_database: bool,
) -> Result<(), CliError> {
    if created_metadata {
        fs::remove_dir_all(metadata_path).map_err(|error| {
            CliError::new(format!(
                "cannot remove {}: {error}",
                metadata_path.display()
            ))
        })?;
    } else if created_database {
        for path in [
            database_path.to_path_buf(),
            metadata_path.join(format!("{DATABASE_FILE}-wal")),
            metadata_path.join(format!("{DATABASE_FILE}-shm")),
        ] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(CliError::new(format!(
                        "cannot remove {}: {error}",
                        path.display()
                    )));
                }
            }
        }
    }
    Ok(())
}

fn verify_base_directories(
    target_realm: Realm,
    options: &[BundleBaseOption],
) -> Result<Vec<ef_store_sqlite::VerifiedBundle>, CliError> {
    let required: &[Realm] = match target_realm {
        Realm::Public => &[],
        Realm::Members => &[Realm::Public],
        Realm::Local => &[Realm::Public, Realm::Members],
    };
    if options.len() != required.len()
        || required
            .iter()
            .any(|realm| !options.iter().any(|option| option.realm == *realm))
    {
        let spelling = match target_realm {
            Realm::Public => "no --base options",
            Realm::Members => "--base public=BUNDLE_DIRECTORY",
            Realm::Local => "--base public=BUNDLE_DIRECTORY and --base members=BUNDLE_DIRECTORY",
        };
        return Err(CliError::new(format!(
            "{} bundle requires {spelling}",
            target_realm.as_str()
        )));
    }

    let mut verified = Vec::new();
    for realm in [Realm::Public, Realm::Members] {
        let Some(option) = options.iter().find(|option| option.realm == realm) else {
            continue;
        };
        let root = canonical_bundle_directory(&option.path)?;
        let (manifest, objects) = read_bundle_directory(&root)?;
        let decoded = decode_bundle_manifest(&manifest)
            .map_err(|error| CliError::new(format!("invalid base bundle manifest: {error}")))?;
        if decoded.realm != realm {
            return Err(CliError::new(format!(
                "--base {} points to a {} bundle",
                realm.as_str(),
                decoded.realm.as_str()
            )));
        }
        let required_bases = if realm == Realm::Public {
            &verified[..0]
        } else {
            verified.as_slice()
        };
        let summary = verify_portable_bundle(&manifest, &objects, required_bases)
            .map_err(|error| CliError::new(format!("invalid {} base: {error}", realm.as_str())))?;
        verified.push(summary);
    }
    Ok(verified)
}

fn canonical_new_directory_path(path: &Path) -> Result<PathBuf, CliError> {
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CliError::new("--output must name a directory"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    Ok(canonical_directory(parent)?.join(name))
}

fn canonical_bundle_directory(path: &Path) -> Result<PathBuf, CliError> {
    reject_symlink_if_present(path, "bundle directory")?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| CliError::new(format!("cannot resolve {}: {error}", path.display())))?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        CliError::new(format!("cannot inspect {}: {error}", canonical.display()))
    })?;
    if !metadata.is_dir() {
        return Err(CliError::new(format!(
            "bundle path is not a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn read_bundle_directory(root: &Path) -> Result<(Vec<u8>, BundleObjects), CliError> {
    let manifest = read_regular_file_limited(
        &root.join("manifest.cbor"),
        "bundle manifest",
        MAX_BUNDLE_MANIFEST_BYTES,
    )?;
    let decoded = decode_bundle_manifest(&manifest)
        .map_err(|error| CliError::new(format!("invalid bundle manifest: {error}")))?;
    let mut expected_objects = BTreeSet::new();
    for (kind, ids) in [
        ("artifacts", &decoded.artifacts),
        ("blobs", &decoded.blobs),
        ("signatures", &decoded.signatures),
    ] {
        for id in ids {
            expected_objects.insert(cli_bundle_object_path(kind, id));
        }
    }
    let mut objects = BTreeMap::new();
    let mut seen_directories = BTreeSet::new();
    for entry in fs::read_dir(root)
        .map_err(|error| CliError::new(format!("cannot read {}: {error}", root.display())))?
    {
        let entry = entry.map_err(|error| CliError::new(format!("cannot read bundle: {error}")))?;
        let name = entry.file_name();
        if name == OsStr::new("manifest.cbor") {
            continue;
        }
        let kind = name
            .to_str()
            .ok_or_else(|| CliError::new("bundle entry name must be valid UTF-8"))?;
        if !matches!(kind, "artifacts" | "blobs" | "signatures") {
            return Err(CliError::new(format!("unexpected bundle entry: {kind}")));
        }
        seen_directories.insert(kind.to_owned());
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            CliError::new(format!(
                "cannot inspect {}: {error}",
                entry.path().display()
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CliError::new(format!("unexpected bundle entry: {kind}")));
        }
        for object in fs::read_dir(entry.path()).map_err(|error| {
            CliError::new(format!("cannot read {}: {error}", entry.path().display()))
        })? {
            let object = object
                .map_err(|error| CliError::new(format!("cannot read bundle object: {error}")))?;
            let file_name = object
                .file_name()
                .into_string()
                .map_err(|_| CliError::new("bundle object name must be valid UTF-8"))?;
            let relative = format!("{kind}/{file_name}");
            if !expected_objects.contains(&relative) {
                return Err(CliError::new(format!(
                    "unexpected bundle object: {relative}"
                )));
            }
            let body = read_regular_file_limited(
                &object.path(),
                "bundle object",
                MAX_BUNDLE_OBJECT_BYTES,
            )?;
            objects.insert(relative, body);
        }
    }
    if seen_directories != BTreeSet::from(["artifacts".into(), "blobs".into(), "signatures".into()])
    {
        return Err(CliError::new(
            "bundle must contain artifacts, blobs, and signatures directories",
        ));
    }
    Ok((manifest, objects))
}

fn cli_bundle_object_path(kind: &str, id: &str) -> String {
    let extension = if kind == "blobs" { "bin" } else { "cbor" };
    format!("{kind}/{}.{extension}", &id[7..])
}

fn read_regular_file_limited(path: &Path, label: &str, limit: u64) -> Result<Vec<u8>, CliError> {
    let before = fs::symlink_metadata(path)
        .map_err(|error| CliError::new(format!("cannot inspect {}: {error}", path.display())))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(CliError::new(format!(
            "{label} must be a regular file: {}",
            path.display()
        )));
    }
    if before.len() > limit {
        return Err(CliError::new(format!("{label} exceeds the size limit")));
    }
    let mut file = File::open(path)
        .map_err(|error| CliError::new(format!("cannot open {}: {error}", path.display())))?;
    let opened = file
        .metadata()
        .map_err(|error| CliError::new(format!("cannot inspect {}: {error}", path.display())))?;
    if !same_file(&before, &opened) {
        return Err(CliError::new(format!("{label} changed while opening")));
    }
    let mut body = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut body)
        .map_err(|error| CliError::new(format!("cannot read {}: {error}", path.display())))?;
    if body.len() as u64 > limit {
        return Err(CliError::new(format!("{label} exceeds the size limit")));
    }
    Ok(body)
}

fn write_bundle_atomically(
    output: &Path,
    manifest: &[u8],
    objects: &BTreeMap<String, Vec<u8>>,
) -> Result<(), CliError> {
    let parent = output
        .parent()
        .ok_or_else(|| CliError::new("invalid bundle output"))?;
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|error| CliError::new(format!("OS random source failed: {error}")))?;
    let mut suffix = String::with_capacity(nonce.len() * 2);
    for byte in nonce {
        let _ = write!(suffix, "{byte:02x}");
    }
    let temporary = parent.join(format!(".edgefoss-export-{suffix}.tmp"));
    fs::create_dir(&temporary).map_err(|error| {
        CliError::new(format!("cannot create {}: {error}", temporary.display()))
    })?;
    let result = (|| -> Result<(), CliError> {
        for kind in ["artifacts", "blobs", "signatures"] {
            fs::create_dir(temporary.join(kind)).map_err(|error| {
                CliError::new(format!("cannot create bundle directory: {error}"))
            })?;
        }
        for (relative, body) in objects {
            write_new_bundle_file(&temporary.join(relative), body)?;
        }
        write_new_bundle_file(&temporary.join("manifest.cbor"), manifest)?;
        if output.exists() {
            return Err(CliError::new(format!(
                "bundle output already exists: {}",
                output.display()
            )));
        }
        fs::rename(&temporary, output)
            .map_err(|error| CliError::new(format!("cannot publish {}: {error}", output.display())))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn write_static_site_atomically(
    output: &Path,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), CliError> {
    let parent = output
        .parent()
        .ok_or_else(|| CliError::new("invalid static site output"))?;
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|error| CliError::new(format!("OS random source failed: {error}")))?;
    let mut suffix = String::with_capacity(nonce.len() * 2);
    for byte in nonce {
        let _ = write!(suffix, "{byte:02x}");
    }
    let temporary = parent.join(format!(".edgefoss-static-{suffix}.tmp"));
    fs::create_dir(&temporary).map_err(|error| {
        CliError::new(format!("cannot create {}: {error}", temporary.display()))
    })?;
    let result = (|| -> Result<(), CliError> {
        for (relative, body) in files {
            let relative = Path::new(relative);
            if relative.is_absolute()
                || relative.components().any(|component| {
                    !matches!(
                        component,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                })
            {
                return Err(CliError::new("static site contains an unsafe output path"));
            }
            let path = temporary.join(relative);
            if let Some(directory) = path.parent() {
                fs::create_dir_all(directory).map_err(|error| {
                    CliError::new(format!("cannot create static site directory: {error}"))
                })?;
            }
            write_new_static_file(&path, body)?;
        }
        if output.exists() {
            return Err(CliError::new(format!(
                "static site output already exists: {}",
                output.display()
            )));
        }
        fs::rename(&temporary, output)
            .map_err(|error| CliError::new(format!("cannot publish {}: {error}", output.display())))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn write_new_static_file(path: &Path, body: &[u8]) -> Result<(), CliError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut file = options
        .open(path)
        .map_err(|error| CliError::new(format!("cannot create {}: {error}", path.display())))?;
    file.write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(|error| CliError::new(format!("cannot write {}: {error}", path.display())))
}

fn write_new_bundle_file(path: &Path, body: &[u8]) -> Result<(), CliError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| CliError::new(format!("cannot create {}: {error}", path.display())))?;
    file.write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(|error| CliError::new(format!("cannot write {}: {error}", path.display())))
}

const fn tree_mode(mode: TreeEntryMode) -> &'static str {
    match mode {
        TreeEntryMode::File => "file",
        TreeEntryMode::Executable => "executable",
        TreeEntryMode::Directory => "directory",
        TreeEntryMode::Symlink => "symlink",
    }
}

fn escape_terminal_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                let _ = write!(escaped, "\\u{{{:x}}}", u32::from(character));
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn sign_artifact(signing_key: &SigningKey, id: &str) -> Result<SignatureRecord, CliError> {
    let message = artifact_signature_message(id)
        .map_err(|error| CliError::new(format!("cannot sign artifact: {error}")))?;
    Ok(SignatureRecord {
        artifact: id.to_owned(),
        actor_key: signing_key.verifying_key().to_bytes(),
        signature: signing_key.sign(&message).to_bytes(),
    })
}

fn canonical_new_file_path(path: &Path) -> Result<PathBuf, CliError> {
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CliError::new("--output must name a file"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    Ok(canonical_directory(parent)?.join(name))
}

fn read_signing_seed(path: &Path, repository_root: &Path) -> Result<Zeroizing<[u8; 32]>, CliError> {
    reject_symlink_if_present(path, "signing key file")?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| CliError::new(format!("cannot resolve {}: {error}", path.display())))?;
    if canonical.starts_with(repository_root) {
        return Err(CliError::new(
            "signing key file must be stored outside the repository",
        ));
    }
    let path_metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        CliError::new(format!("cannot inspect {}: {error}", canonical.display()))
    })?;
    if !path_metadata.is_file() {
        return Err(CliError::new(format!(
            "signing key path is not a regular file: {}",
            canonical.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path_metadata.permissions().mode() & 0o077 != 0 {
            return Err(CliError::new(
                "signing key file must not grant group or other permissions; use chmod 600",
            ));
        }
    }
    let mut file = File::open(&canonical)
        .map_err(|error| CliError::new(format!("cannot open {}: {error}", canonical.display())))?;
    let opened_metadata = file.metadata().map_err(|error| {
        CliError::new(format!("cannot inspect {}: {error}", canonical.display()))
    })?;
    if !same_file(&path_metadata, &opened_metadata) {
        return Err(CliError::new(
            "signing key file changed while it was being opened",
        ));
    }
    let mut encoded = Zeroizing::new(Vec::with_capacity(65));
    (&mut file)
        .take(66)
        .read_to_end(&mut encoded)
        .map_err(|error| CliError::new(format!("cannot read {}: {error}", canonical.display())))?;
    let key_bytes = match encoded.as_slice() {
        bytes if bytes.len() == 64 => bytes,
        bytes if bytes.len() == 65 && bytes[64] == b'\n' => &bytes[..64],
        _ => {
            return Err(CliError::new(
                "signing key file must contain exactly 64 lowercase hexadecimal characters and an optional newline",
            ));
        }
    };
    if !key_bytes
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(CliError::new(
            "signing key file must contain exactly 64 lowercase hexadecimal characters and an optional newline",
        ));
    }
    let mut seed = Zeroizing::new([0_u8; 32]);
    for (index, pair) in key_bytes.chunks_exact(2).enumerate() {
        seed[index] = (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]);
    }
    Ok(seed)
}

fn encode_secret_seed(seed: &[u8; 32]) -> Zeroizing<Vec<u8>> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = Zeroizing::new(Vec::with_capacity(65));
    for byte in seed {
        encoded.push(HEX[usize::from(byte >> 4)]);
        encoded.push(HEX[usize::from(byte & 0x0f)]);
    }
    encoded.push(b'\n');
    encoded
}

fn encode_public_key(key: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in key {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn run_status(options: &StatusOptions) -> Result<(), CliError> {
    let start = canonical_directory(&options.path)?;
    let root = find_repository_root(&start)?.ok_or_else(|| {
        CliError::new(format!(
            "no EdgeFossil repository found from {}",
            start.display()
        ))
    })?;
    let database_path = root.join(METADATA_DIRECTORY).join(DATABASE_FILE);
    let repository = open_repository(&database_path)?;
    let project_id = repository
        .project_id()
        .map_err(|error| CliError::new(error.to_string()))?
        .ok_or_else(|| CliError::new("repository database is not initialized"))?;
    let genesis = repository
        .project_genesis()
        .map_err(|error| CliError::new(error.to_string()))?
        .ok_or_else(|| CliError::new("repository genesis is missing"))?;
    repository
        .quick_check()
        .map_err(|error| CliError::new(error.to_string()))?;
    let schema_version = repository
        .schema_version()
        .map_err(|error| CliError::new(error.to_string()))?;
    let tracking_counts = repository
        .tracking_counts()
        .map_err(|error| CliError::new(error.to_string()))?;
    let snapshot_roots = repository
        .working_snapshot_roots()
        .map_err(|error| CliError::new(error.to_string()))?;
    let checkpoint_heads = repository
        .checkpoint_heads()
        .map_err(|error| CliError::new(error.to_string()))?;

    println!("repository: {}", root.display());
    println!("project: {project_id}");
    println!("name: {}", escape_terminal_text(&genesis.name));
    println!("schema: {schema_version}");
    println!("integrity: ok");
    println!("tracking-project: {}", tracking_counts.project);
    println!("tracking-local: {}", tracking_counts.local);
    println!("tracking-none: {}", tracking_counts.none);
    for realm in [Realm::Public, Realm::Members, Realm::Local] {
        let root = snapshot_roots
            .iter()
            .find(|root| root.realm == realm)
            .map_or("-", |root| root.id.as_str());
        println!("working-root-{}: {root}", realm.as_str());
        let head = checkpoint_heads.iter().find(|head| head.realm == realm);
        println!(
            "checkpoint-head-{}: {}",
            realm.as_str(),
            head.map_or("-", |head| head.id.as_str())
        );
        println!(
            "checkpoint-generation-{}: {}",
            realm.as_str(),
            head.map_or(0, |head| head.generation)
        );
    }
    if let Some(target) = &options.explain {
        let (selector, _) = repository_selector(&root, &start, target)?;
        let rule = repository
            .resolve_tracking(&selector)
            .map_err(|error| CliError::new(error.to_string()))?;
        print_tracking_explanation(&selector, rule.as_ref());
    }
    Ok(())
}

fn run_track(options: &TrackOptions) -> Result<(), CliError> {
    let start = canonical_directory(&options.path)?;
    let root = find_repository_root(&start)?.ok_or_else(|| {
        CliError::new(format!(
            "no EdgeFossil repository found from {}",
            start.display()
        ))
    })?;
    let (selector, disk_path) = repository_selector(&root, &start, &options.target)?;
    let metadata = fs::symlink_metadata(&disk_path)
        .map_err(|error| CliError::new(format!("cannot track {}: {error}", disk_path.display())))?;
    let scope = if metadata.is_dir() {
        TrackingScope::Prefix
    } else {
        TrackingScope::Path
    };
    let (mode, realm) = match options.selection {
        TrackSelection::None => (TrackingMode::None, None),
        TrackSelection::Local => (TrackingMode::Local, Some(Realm::Local)),
        TrackSelection::Project(realm) => (TrackingMode::Project, Some(realm)),
    };
    let rule = TrackingRule::new(selector, scope, mode, realm)
        .map_err(|error| CliError::new(error.to_string()))?;
    let database_path = root.join(METADATA_DIRECTORY).join(DATABASE_FILE);
    let mut repository = open_repository(&database_path)?;
    repository
        .set_tracking_rule(&rule)
        .map_err(|error| CliError::new(error.to_string()))?;
    println!("selector: {} {}", rule.scope().as_str(), rule.selector());
    println!("tracking: {}", rule.mode().as_str());
    println!("realm: {}", rule.realm().map_or("-", Realm::as_str));
    Ok(())
}

fn run_snapshot(options: &SnapshotOptions) -> Result<(), CliError> {
    let start = canonical_directory(&options.path)?;
    let root = find_repository_root(&start)?.ok_or_else(|| {
        CliError::new(format!(
            "no EdgeFossil repository found from {}",
            start.display()
        ))
    })?;
    let database_path = root.join(METADATA_DIRECTORY).join(DATABASE_FILE);
    let mut repository = open_repository(&database_path)?;
    let project = repository
        .project_id()
        .map_err(|error| CliError::new(error.to_string()))?
        .ok_or_else(|| CliError::new("repository database is not initialized"))?;
    let genesis = repository
        .project_genesis()
        .map_err(|error| CliError::new(error.to_string()))?
        .ok_or_else(|| CliError::new("repository genesis is missing"))?;
    let rules = repository
        .tracking_rules()
        .map_err(|error| CliError::new(error.to_string()))?;
    let inputs = collect_snapshot_inputs(&root, &repository, &rules)?;
    let snapshots =
        build_realm_snapshots(&project, genesis.actor_key, &genesis.created_at, &inputs)
            .map_err(|error| CliError::new(error.to_string()))?;
    let captured_at = current_timestamp()?;
    repository
        .replace_working_snapshots(&snapshots, &captured_at)
        .map_err(|error| CliError::new(error.to_string()))?;
    if snapshots.is_empty() {
        println!("snapshot: empty");
    } else {
        for snapshot in snapshots {
            println!("root-{}: {}", snapshot.realm.as_str(), snapshot.root);
            println!(
                "blobs-{}: {}",
                snapshot.realm.as_str(),
                snapshot.blobs.len()
            );
            println!(
                "trees-{}: {}",
                snapshot.realm.as_str(),
                snapshot.trees.len()
            );
        }
    }
    println!("captured-at: {captured_at}");
    Ok(())
}

fn collect_snapshot_inputs(
    root: &Path,
    repository: &LocalRepository,
    rules: &[TrackingRule],
) -> Result<Vec<SnapshotInput>, CliError> {
    let mut candidates = BTreeSet::new();
    for rule in rules
        .iter()
        .filter(|rule| rule.mode() != TrackingMode::None)
    {
        let disk_path = repository_path(root, rule.selector());
        match rule.scope() {
            TrackingScope::Path => {
                fs::symlink_metadata(&disk_path).map_err(|error| {
                    CliError::new(format!(
                        "tracked path is unavailable {}: {error}",
                        disk_path.display()
                    ))
                })?;
                candidates.insert(rule.selector().to_owned());
            }
            TrackingScope::Prefix => {
                collect_subtree(root, &disk_path, rule.selector(), &mut candidates)?;
            }
        }
    }

    let mut inputs = Vec::new();
    for selector in candidates {
        let Some(rule) = repository
            .resolve_tracking(&selector)
            .map_err(|error| CliError::new(error.to_string()))?
        else {
            continue;
        };
        let Some(realm) = rule.realm() else {
            continue;
        };
        let kind = read_snapshot_input(root, &selector)?;
        inputs.push(SnapshotInput {
            path: selector,
            realm,
            kind,
        });
    }
    Ok(inputs)
}

fn collect_subtree(
    root: &Path,
    disk_path: &Path,
    selector: &str,
    output: &mut BTreeSet<String>,
) -> Result<(), CliError> {
    let metadata = fs::symlink_metadata(disk_path).map_err(|error| {
        CliError::new(format!(
            "tracked path is unavailable {}: {error}",
            disk_path.display()
        ))
    })?;
    output.insert(selector.into());
    if !metadata.is_dir() {
        return Ok(());
    }
    let canonical = fs::canonicalize(disk_path).map_err(|error| {
        CliError::new(format!("cannot resolve {}: {error}", disk_path.display()))
    })?;
    if !canonical.starts_with(root) {
        return Err(CliError::new(format!(
            "tracked directory escapes repository: {}",
            disk_path.display()
        )));
    }
    let mut children = fs::read_dir(disk_path)
        .map_err(|error| CliError::new(format!("cannot read {}: {error}", disk_path.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::new(format!("cannot read {}: {error}", disk_path.display())))?;
    children.sort_by_key(std::fs::DirEntry::file_name);
    for child in children {
        let name = child
            .file_name()
            .into_string()
            .map_err(|_| CliError::new("tracked filesystem names must be valid UTF-8"))?;
        let child_selector = format!("{selector}/{name}");
        validate_path(&child_selector).map_err(|error| {
            CliError::new(format!("invalid tracked path {child_selector}: {error}"))
        })?;
        collect_subtree(root, &child.path(), &child_selector, output)?;
    }
    Ok(())
}

fn repository_path(root: &Path, selector: &str) -> PathBuf {
    selector
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

fn read_snapshot_input(root: &Path, selector: &str) -> Result<SnapshotInputKind, CliError> {
    let path = repository_path(root, selector);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        CliError::new(format!("tracked path changed {}: {error}", path.display()))
    })?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        let target = fs::read_link(&path)
            .map_err(|error| CliError::new(format!("cannot read {}: {error}", path.display())))?;
        let target = target
            .to_str()
            .ok_or_else(|| CliError::new("symlink target must be valid UTF-8"))?;
        validate_symlink_within_root(selector, target)?;
        return Ok(SnapshotInputKind::Symlink {
            target: target.into(),
        });
    }
    if file_type.is_dir() {
        return Ok(SnapshotInputKind::Directory);
    }
    if !file_type.is_file() {
        return Err(CliError::new(format!(
            "unsupported tracked file type: {}",
            path.display()
        )));
    }
    let (bytes, executable) = read_stable_file(&path, &metadata)?;
    Ok(SnapshotInputKind::File { bytes, executable })
}

fn read_stable_file(path: &Path, path_metadata: &Metadata) -> Result<(Vec<u8>, bool), CliError> {
    let mut file = File::open(path)
        .map_err(|error| CliError::new(format!("cannot open {}: {error}", path.display())))?;
    let before = file
        .metadata()
        .map_err(|error| CliError::new(format!("cannot inspect {}: {error}", path.display())))?;
    if !same_file(path_metadata, &before) {
        return Err(CliError::new(format!(
            "tracked file changed while opening: {}",
            path.display()
        )));
    }
    if before.len() > MAX_SNAPSHOT_BLOB_BYTES {
        return Err(CliError::new(format!(
            "tracked file exceeds the 16 MiB alpha limit: {}",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(before.len()).unwrap_or(0));
    (&mut file)
        .take(MAX_SNAPSHOT_BLOB_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CliError::new(format!("cannot read {}: {error}", path.display())))?;
    let after = file
        .metadata()
        .map_err(|error| CliError::new(format!("cannot inspect {}: {error}", path.display())))?;
    if bytes.len() as u64 != before.len() || !same_file(&before, &after) {
        return Err(CliError::new(format!(
            "tracked file changed while reading: {}",
            path.display()
        )));
    }
    Ok((bytes, is_executable(&before)))
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    if left.len() != right.len()
        || left.file_type() != right.file_type()
        || left.modified().ok() != right.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn is_executable(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn validate_symlink_within_root(selector: &str, target: &str) -> Result<(), CliError> {
    let bytes = target.as_bytes();
    let drive_prefix = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if target.is_empty() || target.starts_with(['/', '\\']) || drive_prefix {
        return Err(CliError::new(format!(
            "symlink target is absolute or invalid: {selector}"
        )));
    }
    let mut depth = selector.split('/').count() - 1;
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." if depth == 0 => {
                return Err(CliError::new(format!(
                    "symlink target escapes repository: {selector}"
                )));
            }
            ".." => depth -= 1,
            _ => depth += 1,
        }
    }
    Ok(())
}

fn print_tracking_explanation(path: &str, rule: Option<&TrackingRule>) {
    println!("explain-path: {path}");
    if let Some(rule) = rule {
        println!("effective-tracking: {}", rule.mode().as_str());
        println!(
            "effective-realm: {}",
            rule.realm().map_or("-", Realm::as_str)
        );
        println!(
            "matched-rule: {} {}",
            rule.scope().as_str(),
            rule.selector()
        );
    } else {
        println!("effective-tracking: none");
        println!("effective-realm: -");
        println!("matched-rule: default");
    }
}

fn repository_selector(
    root: &Path,
    start: &Path,
    target: &OsStr,
) -> Result<(String, PathBuf), CliError> {
    let target = Path::new(target);
    if target.is_absolute() {
        return Err(CliError::new(
            "TARGET must be relative to the selected directory",
        ));
    }
    let relative_start = start
        .strip_prefix(root)
        .map_err(|_| CliError::new("selected directory is outside the discovered repository"))?;
    let mut segments = Vec::new();
    append_portable_segments(&mut segments, relative_start)?;
    append_portable_segments(&mut segments, target)?;
    if segments.is_empty() {
        return Err(CliError::new(
            "the repository root cannot be a tracking selector in this increment",
        ));
    }
    if segments
        .first()
        .is_some_and(|segment| segment == METADATA_DIRECTORY)
    {
        return Err(CliError::new(
            "EdgeFossil repository metadata cannot be tracked",
        ));
    }
    let selector = segments.join("/");
    validate_path(&selector)
        .map_err(|error| CliError::new(format!("invalid repository path: {error}")))?;
    let disk_path = segments
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    Ok((selector, disk_path))
}

fn append_portable_segments(segments: &mut Vec<String>, path: &Path) -> Result<(), CliError> {
    for component in path.components() {
        match component {
            std::path::Component::Normal(segment) => segments.push(
                segment
                    .to_str()
                    .ok_or_else(|| CliError::new("TARGET must be valid UTF-8"))?
                    .to_owned(),
            ),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(CliError::new(
                    "TARGET must not contain parent or absolute path components",
                ));
            }
        }
    }
    Ok(())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, CliError> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| CliError::new(format!("cannot resolve {}: {error}", path.display())))?;
    if !canonical.is_dir() {
        return Err(CliError::new(format!(
            "path is not a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn find_repository_root(start: &Path) -> Result<Option<PathBuf>, CliError> {
    for candidate in start.ancestors() {
        let metadata_path = candidate.join(METADATA_DIRECTORY);
        reject_symlink_if_present(&metadata_path, "repository metadata directory")?;
        let database_path = metadata_path.join(DATABASE_FILE);
        reject_symlink_if_present(&database_path, "repository database")?;
        if database_path.is_file() {
            return Ok(Some(candidate.to_path_buf()));
        }
    }
    Ok(None)
}

fn reject_symlink_if_present(path: &Path, label: &str) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CliError::new(format!(
            "{label} must not be a symbolic link: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CliError::new(format!(
            "cannot inspect {}: {error}",
            path.display()
        ))),
    }
}

fn create_metadata_directory(path: &Path) -> Result<(), CliError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|error| CliError::new(format!("cannot create {}: {error}", path.display())))
}

fn create_database_file(path: &Path) -> Result<(), CliError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map(|_| ())
        .map_err(|error| CliError::new(format!("cannot create {}: {error}", path.display())))
}

fn open_repository(path: &Path) -> Result<LocalRepository, CliError> {
    LocalRepository::open(path).map_err(|error| CliError::new(error.to_string()))
}

fn current_timestamp() -> Result<String, CliError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CliError::new(format!("system clock is before Unix epoch: {error}")))?
        .as_secs();
    format_timestamp(seconds)
}

fn format_timestamp(seconds: u64) -> Result<String, CliError> {
    let days = i64::try_from(seconds / 86_400)
        .map_err(|_| CliError::new("system time is outside the supported range"))?;
    let second_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    if !(0..=9999).contains(&year) {
        return Err(CliError::new("system time is outside RFC 3339 year range"));
    }
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    ))
}

const fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::{format_timestamp, parse_actor_key};

    #[test]
    fn formats_utc_timestamp_at_whole_second_precision() {
        assert_eq!(format_timestamp(0).unwrap(), "1970-01-01T00:00:00Z");
        assert_eq!(
            format_timestamp(951_782_400).unwrap(),
            "2000-02-29T00:00:00Z"
        );
    }

    #[test]
    fn actor_key_requires_canonical_lowercase_hex() {
        assert!(parse_actor_key(&"a5".repeat(32)).is_ok());
        assert!(parse_actor_key(&"A5".repeat(32)).is_err());
        assert!(parse_actor_key("a5").is_err());
    }
}
