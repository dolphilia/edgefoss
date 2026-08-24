//! Local `EdgeFossil` command-line workflows.

use std::{
    collections::BTreeSet,
    error::Error,
    ffi::{OsStr, OsString},
    fmt, fs,
    fs::{File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use edgefoss_core::{SnapshotInput, SnapshotInputKind, build_realm_snapshots};
use ef_format::{ProjectGenesis, Realm, encode_project_genesis, validate_path};
use ef_store_sqlite::{LocalRepository, TrackingMode, TrackingRule, TrackingScope};

const METADATA_DIRECTORY: &str = ".edgefossil";
const DATABASE_FILE: &str = "repository.sqlite3";
const MAX_SNAPSHOT_BLOB_BYTES: u64 = 16 * 1024 * 1024;
const HELP: &str = "EdgeFossil local repository CLI

Usage:
  ef init --name <NAME> --actor-key <64 LOWERCASE HEX> [--path <DIRECTORY>]
  ef track [--local | --none | --realm <public|members>] [--path <DIRECTORY>] <TARGET>
  ef snapshot [--path <DIRECTORY>]
  ef status [--path <DIRECTORY>] [--explain <TARGET>]
  ef --help
  ef --version

The actor key is an Ed25519 public key. This command does not generate or store
a private key.";

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
        Some("init") => run_init(parse_init(arguments)?),
        Some("track") => run_track(&parse_track(arguments)?),
        Some("snapshot") => run_snapshot(&parse_snapshot(arguments)?),
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

    println!("repository: {}", root.display());
    println!("project: {project_id}");
    println!("name: {}", genesis.name);
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
