//! Local `EdgeFossil` command-line workflows.

use std::{
    error::Error,
    ffi::OsString,
    fmt, fs,
    fs::OpenOptions,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use ef_format::{ProjectGenesis, encode_project_genesis};
use ef_store_sqlite::LocalRepository;

const METADATA_DIRECTORY: &str = ".edgefossil";
const DATABASE_FILE: &str = "repository.sqlite3";
const HELP: &str = "EdgeFossil local repository CLI

Usage:
  ef init --name <NAME> --actor-key <64 LOWERCASE HEX> [--path <DIRECTORY>]
  ef status [--path <DIRECTORY>]
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
    let mut arguments = arguments.peekable();
    while let Some(option) = arguments.next() {
        match option.to_str() {
            Some("--path") => set_once(
                &mut path,
                PathBuf::from(parse_value(&mut arguments, "--path")?),
                "--path",
            )?,
            Some(other) => return Err(CliError::new(format!("unknown status option `{other}`"))),
            None => return Err(CliError::new("status option must be valid UTF-8")),
        }
    }
    Ok(StatusOptions {
        path: path.unwrap_or_else(|| PathBuf::from(".")),
    })
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

    println!("repository: {}", root.display());
    println!("project: {project_id}");
    println!("name: {}", genesis.name);
    println!("schema: {schema_version}");
    println!("integrity: ok");
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
