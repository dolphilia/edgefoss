use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

const ACTOR_KEY: &str = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let serial = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("edgefoss-cli-{}-{serial}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl AsRef<Path> for TestDirectory {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn ef(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_ef"))
        .args(arguments)
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}

#[test]
fn initializes_repository_and_reports_status() {
    let directory = TestDirectory::new();
    let path = directory.as_ref().to_str().unwrap();
    let initialized = ef(&[
        "init",
        "--name",
        "Example",
        "--actor-key",
        ACTOR_KEY,
        "--path",
        path,
    ]);
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    assert!(
        directory
            .as_ref()
            .join(".edgefossil/repository.sqlite3")
            .is_file()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata_mode = fs::metadata(directory.as_ref().join(".edgefossil"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let database_mode = fs::metadata(directory.as_ref().join(".edgefossil/repository.sqlite3"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(metadata_mode & 0o077, 0);
        assert_eq!(metadata_mode & 0o700, 0o700);
        assert_eq!(database_mode & 0o077, 0);
        assert_eq!(database_mode & 0o600, 0o600);
    }
    let project_id = stdout(&initialized)
        .lines()
        .find_map(|line| line.strip_prefix("initialized: "))
        .unwrap()
        .to_owned();

    let status = ef(&["status", "--path", path]);
    assert!(status.status.success(), "{}", stderr(&status));
    let status = stdout(&status);
    assert!(status.contains(&format!("project: {project_id}\n")));
    assert!(status.contains("name: Example\n"));
    assert!(status.contains("schema: 1\n"));
    assert!(status.contains("integrity: ok\n"));
}

#[test]
fn status_discovers_repository_from_child_directory() {
    let directory = TestDirectory::new();
    let root = directory.as_ref().to_str().unwrap();
    let initialized = ef(&[
        "init",
        "--name",
        "Nested",
        "--actor-key",
        ACTOR_KEY,
        "--path",
        root,
    ]);
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    let child = directory.as_ref().join("one/two");
    fs::create_dir_all(&child).unwrap();

    let status = ef(&["status", "--path", child.to_str().unwrap()]);
    assert!(status.status.success(), "{}", stderr(&status));
    let expected_root = fs::canonicalize(directory.as_ref()).unwrap();
    assert!(stdout(&status).contains(&format!("repository: {}\n", expected_root.display())));
}

#[test]
fn repeated_init_is_rejected_without_changing_identity() {
    let directory = TestDirectory::new();
    let path = directory.as_ref().to_str().unwrap();
    let first = ef(&[
        "init",
        "--name",
        "First",
        "--actor-key",
        ACTOR_KEY,
        "--path",
        path,
    ]);
    assert!(first.status.success(), "{}", stderr(&first));
    let project_id = stdout(&first)
        .lines()
        .find_map(|line| line.strip_prefix("initialized: "))
        .unwrap()
        .to_owned();

    let second = ef(&[
        "init",
        "--name",
        "Second",
        "--actor-key",
        ACTOR_KEY,
        "--path",
        path,
    ]);
    assert!(!second.status.success());
    assert!(stderr(&second).contains("already initialized"));
    let status = ef(&["status", "--path", path]);
    assert!(stdout(&status).contains(&format!("project: {project_id}\n")));
    assert!(stdout(&status).contains("name: First\n"));
}

#[test]
fn invalid_actor_key_leaves_no_repository_metadata() {
    let directory = TestDirectory::new();
    let path = directory.as_ref().to_str().unwrap();
    let output = ef(&[
        "init",
        "--name",
        "Invalid",
        "--actor-key",
        "ABC",
        "--path",
        path,
    ]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("64 lowercase hexadecimal"));
    assert!(!directory.as_ref().join(".edgefossil").exists());
}

#[test]
fn invalid_project_name_leaves_no_repository_metadata() {
    let directory = TestDirectory::new();
    let output = ef(&[
        "init",
        "--name",
        "",
        "--actor-key",
        ACTOR_KEY,
        "--path",
        directory.as_ref().to_str().unwrap(),
    ]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("name must be NFC and 1-128 UTF-8 bytes"));
    assert!(!directory.as_ref().join(".edgefossil").exists());
}

#[test]
fn status_without_repository_is_read_only() {
    let directory = TestDirectory::new();
    let output = ef(&["status", "--path", directory.as_ref().to_str().unwrap()]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("no EdgeFossil repository found"));
    assert!(!directory.as_ref().join(".edgefossil").exists());
}

#[cfg(unix)]
#[test]
fn metadata_symbolic_link_is_rejected() {
    use std::os::unix::fs::symlink;

    let directory = TestDirectory::new();
    let redirected = TestDirectory::new();
    symlink(redirected.as_ref(), directory.as_ref().join(".edgefossil")).unwrap();
    let output = ef(&[
        "init",
        "--name",
        "Redirected",
        "--actor-key",
        ACTOR_KEY,
        "--path",
        directory.as_ref().to_str().unwrap(),
    ]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("must not be a symbolic link"));
    assert!(!redirected.as_ref().join("repository.sqlite3").exists());
}
