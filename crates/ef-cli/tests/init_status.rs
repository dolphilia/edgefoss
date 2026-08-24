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

fn initialize(directory: &TestDirectory, name: &str) -> Output {
    ef(&[
        "init",
        "--name",
        name,
        "--actor-key",
        ACTOR_KEY,
        "--path",
        directory.as_ref().to_str().unwrap(),
    ])
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
    assert!(status.contains("schema: 3\n"));
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

#[test]
fn tracks_directory_and_explains_inherited_public_rule() {
    let directory = TestDirectory::new();
    let initialized = initialize(&directory, "Tracking");
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    fs::create_dir(directory.as_ref().join("src")).unwrap();
    fs::write(directory.as_ref().join("src/lib.rs"), "pub fn demo() {}\n").unwrap();

    let tracked = ef(&[
        "track",
        "--path",
        directory.as_ref().to_str().unwrap(),
        "src/",
    ]);
    assert!(tracked.status.success(), "{}", stderr(&tracked));
    assert!(stdout(&tracked).contains("selector: prefix src\n"));
    assert!(stdout(&tracked).contains("tracking: project\n"));
    assert!(stdout(&tracked).contains("realm: public\n"));

    let status = ef(&[
        "status",
        "--path",
        directory.as_ref().to_str().unwrap(),
        "--explain",
        "src/lib.rs",
    ]);
    assert!(status.status.success(), "{}", stderr(&status));
    let status = stdout(&status);
    assert!(status.contains("tracking-project: 1\n"));
    assert!(status.contains("effective-tracking: project\n"));
    assert!(status.contains("effective-realm: public\n"));
    assert!(status.contains("matched-rule: prefix src\n"));
}

#[test]
fn persists_project_local_and_none_destinations() {
    let directory = TestDirectory::new();
    let initialized = initialize(&directory, "Destinations");
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    fs::create_dir_all(directory.as_ref().join("ops")).unwrap();
    fs::create_dir_all(directory.as_ref().join("notes")).unwrap();
    fs::write(directory.as_ref().join("ops/runbook.md"), "restricted\n").unwrap();
    fs::write(directory.as_ref().join("notes/private.md"), "local\n").unwrap();
    fs::write(directory.as_ref().join("generated.txt"), "ignored\n").unwrap();

    for (options, expected) in [
        (
            vec!["--realm", "members", "ops/runbook.md"],
            "realm: members\n",
        ),
        (vec!["--local", "notes/private.md"], "realm: local\n"),
        (vec!["--none", "generated.txt"], "realm: -\n"),
    ] {
        let mut arguments = vec!["track", "--path", directory.as_ref().to_str().unwrap()];
        arguments.extend(options);
        let tracked = ef(&arguments);
        assert!(tracked.status.success(), "{}", stderr(&tracked));
        assert!(stdout(&tracked).contains(expected));
    }

    let status = ef(&["status", "--path", directory.as_ref().to_str().unwrap()]);
    let status = stdout(&status);
    assert!(status.contains("tracking-project: 1\n"));
    assert!(status.contains("tracking-local: 1\n"));
    assert!(status.contains("tracking-none: 1\n"));
}

#[test]
fn rejects_conflicting_tracking_destinations_and_metadata_target() {
    let directory = TestDirectory::new();
    let initialized = initialize(&directory, "Rejected");
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    fs::write(directory.as_ref().join("file.txt"), "content\n").unwrap();
    let root = directory.as_ref().to_str().unwrap();

    let conflict = ef(&[
        "track", "--path", root, "--local", "--realm", "members", "file.txt",
    ]);
    assert!(!conflict.status.success());
    assert!(stderr(&conflict).contains("conflicts with another tracking destination"));

    let metadata = ef(&["track", "--path", root, ".edgefossil"]);
    assert!(!metadata.status.success());
    assert!(stderr(&metadata).contains("repository metadata cannot be tracked"));

    let traversal = ef(&["track", "--path", root, "../file.txt"]);
    assert!(!traversal.status.success());
    assert!(stderr(&traversal).contains("must not contain parent"));

    let absolute = ef(&["track", "--path", root, root]);
    assert!(!absolute.status.success());
    assert!(stderr(&absolute).contains("TARGET must be relative"));

    let status = ef(&["status", "--path", root]);
    let status = stdout(&status);
    assert!(status.contains("tracking-project: 0\n"));
    assert!(status.contains("tracking-local: 0\n"));
    assert!(status.contains("tracking-none: 0\n"));
}

fn output_value(output: &Output, prefix: &str) -> String {
    stdout(output)
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .unwrap()
        .to_owned()
}

#[test]
fn snapshots_realm_roots_without_cross_realm_churn() {
    let directory = TestDirectory::new();
    let initialized = initialize(&directory, "Snapshots");
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    for (path, content) in [
        ("public.txt", "public\n"),
        ("members.txt", "members one\n"),
        ("local.txt", "local\n"),
        ("ignored.txt", "ignored\n"),
    ] {
        fs::write(directory.as_ref().join(path), content).unwrap();
    }
    let root = directory.as_ref().to_str().unwrap();
    for arguments in [
        vec!["track", "--path", root, "public.txt"],
        vec!["track", "--path", root, "--realm", "members", "members.txt"],
        vec!["track", "--path", root, "--local", "local.txt"],
        vec!["track", "--path", root, "--none", "ignored.txt"],
    ] {
        let tracked = ef(&arguments);
        assert!(tracked.status.success(), "{}", stderr(&tracked));
    }

    let first = ef(&["snapshot", "--path", root]);
    assert!(first.status.success(), "{}", stderr(&first));
    assert!(stdout(&first).contains("blobs-public: 1\n"));
    assert!(stdout(&first).contains("blobs-members: 1\n"));
    assert!(stdout(&first).contains("blobs-local: 1\n"));
    let first_public = output_value(&first, "root-public: ");
    let first_members = output_value(&first, "root-members: ");
    let first_local = output_value(&first, "root-local: ");

    fs::write(directory.as_ref().join("members.txt"), "members two\n").unwrap();
    let second = ef(&["snapshot", "--path", root]);
    assert!(second.status.success(), "{}", stderr(&second));
    assert_eq!(output_value(&second, "root-public: "), first_public);
    assert_ne!(output_value(&second, "root-members: "), first_members);
    assert_eq!(output_value(&second, "root-local: "), first_local);

    let status = ef(&["status", "--path", root]);
    assert!(status.status.success(), "{}", stderr(&status));
    assert!(stdout(&status).contains(&format!("working-root-public: {first_public}\n")));
}

#[cfg(unix)]
#[test]
fn escaping_symlink_aborts_snapshot_without_replacing_root() {
    use std::os::unix::fs::symlink;

    let directory = TestDirectory::new();
    let initialized = initialize(&directory, "Symlinks");
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    fs::write(directory.as_ref().join("safe.txt"), "safe\n").unwrap();
    let root = directory.as_ref().to_str().unwrap();
    assert!(ef(&["track", "--path", root, "safe.txt"]).status.success());
    let first = ef(&["snapshot", "--path", root]);
    assert!(first.status.success(), "{}", stderr(&first));
    let first_root = output_value(&first, "root-public: ");

    symlink("../outside", directory.as_ref().join("escape")).unwrap();
    assert!(ef(&["track", "--path", root, "escape"]).status.success());
    let rejected = ef(&["snapshot", "--path", root]);
    assert!(!rejected.status.success());
    assert!(stderr(&rejected).contains("symlink target escapes repository"));
    let status = ef(&["status", "--path", root]);
    assert!(stdout(&status).contains(&format!("working-root-public: {first_root}\n")));
}
