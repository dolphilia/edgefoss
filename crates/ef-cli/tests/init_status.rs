use std::{
    collections::BTreeMap,
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

fn bundle_contents(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut contents = BTreeMap::new();
    contents.insert(
        "manifest.cbor".into(),
        fs::read(root.join("manifest.cbor")).unwrap(),
    );
    for kind in ["artifacts", "blobs", "signatures"] {
        for entry in fs::read_dir(root.join(kind)).unwrap() {
            let entry = entry.unwrap();
            contents.insert(
                format!("{kind}/{}", entry.file_name().to_string_lossy()),
                fs::read(entry.path()).unwrap(),
            );
        }
    }
    contents
}

fn directory_contents(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, current: &Path, contents: &mut BTreeMap<String, Vec<u8>>) {
        let mut entries = fs::read_dir(current)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), contents);
            } else {
                contents.insert(
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    let mut contents = BTreeMap::new();
    visit(root, root, &mut contents);
    contents
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
    assert!(status.contains("schema: 4\n"));
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

struct CheckpointFixture {
    directory: TestDirectory,
    _key_directory: TestDirectory,
    public_head: String,
    members_head: String,
    local_head: String,
    second_public_head: String,
}

impl CheckpointFixture {
    fn new() -> Self {
        let directory = TestDirectory::new();
        let key_directory = TestDirectory::new();
        let key_path = key_directory.as_ref().join("owner.seed");
        let generated = ef(&["keygen", "--output", key_path.to_str().unwrap()]);
        assert!(generated.status.success(), "{}", stderr(&generated));
        let actor_key = output_value(&generated, "actor-key: ");
        assert_eq!(actor_key.len(), 64);
        assert_eq!(
            output_value(&generated, "signing-key-file: "),
            fs::canonicalize(&key_path).unwrap().to_string_lossy()
        );
        assert_eq!(stdout(&generated).lines().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&key_path).unwrap().permissions().mode() & 0o077,
                0
            );
        }

        let root = directory.as_ref().to_str().unwrap();
        let initialized = ef(&[
            "init",
            "--name",
            "Checkpoints",
            "--actor-key",
            &actor_key,
            "--path",
            root,
        ]);
        assert!(initialized.status.success(), "{}", stderr(&initialized));
        fs::write(directory.as_ref().join("public.txt"), "public\n").unwrap();
        fs::write(directory.as_ref().join("members.txt"), "members\n").unwrap();
        fs::write(directory.as_ref().join("local.txt"), "local\n").unwrap();
        assert!(
            ef(&["track", "--path", root, "public.txt"])
                .status
                .success()
        );
        assert!(
            ef(&["track", "--path", root, "--realm", "members", "members.txt"])
                .status
                .success()
        );
        assert!(
            ef(&["track", "--path", root, "--local", "local.txt"])
                .status
                .success()
        );
        assert!(ef(&["snapshot", "--path", root]).status.success());
        let checkpoint = |realm: &str, message: &str| {
            let output = ef(&[
                "checkpoint",
                "--path",
                root,
                "--realm",
                realm,
                "-m",
                message,
                "--signing-key-file",
                key_path.to_str().unwrap(),
            ]);
            assert!(output.status.success(), "{}", stderr(&output));
            output
        };
        let public = checkpoint("public", "public message");
        let public_head = output_value(&public, "checkpoint-public: ");
        assert!(stdout(&public).contains("generation: 1\n"));
        let members = checkpoint("members", "members-only message");
        let members_head = output_value(&members, "checkpoint-members: ");
        assert!(stdout(&members).contains("generation: 1\n"));
        let local = checkpoint("local", "local-only message");
        let local_head = output_value(&local, "checkpoint-local: ");
        assert!(stdout(&local).contains("generation: 1\n"));
        let second_public = checkpoint("public", "second\npublic\tmessage\u{1b}");
        let second_public_head = output_value(&second_public, "checkpoint-public: ");
        assert!(stdout(&second_public).contains("generation: 2\n"));
        Self {
            directory,
            _key_directory: key_directory,
            public_head,
            members_head,
            local_head,
            second_public_head,
        }
    }

    fn root(&self) -> &str {
        self.directory.as_ref().to_str().unwrap()
    }
}

struct ExportedBundles {
    _directory: TestDirectory,
    public: PathBuf,
    members: PathBuf,
    local: PathBuf,
    public_base: String,
    members_base: String,
}

impl ExportedBundles {
    fn from_repository(repository: &str) -> Self {
        let directory = TestDirectory::new();
        let public = directory.as_ref().join("public.edge");
        let members = directory.as_ref().join("members.edge");
        let local = directory.as_ref().join("local.edge");
        let public_base = format!("public={}", public.display());
        let members_base = format!("members={}", members.display());
        for arguments in [
            vec![
                "export",
                "--path",
                repository,
                "--realm",
                "public",
                "--output",
                public.to_str().unwrap(),
            ],
            vec![
                "export",
                "--path",
                repository,
                "--realm",
                "members",
                "--base",
                &public_base,
                "--output",
                members.to_str().unwrap(),
            ],
            vec![
                "export",
                "--path",
                repository,
                "--realm",
                "local",
                "--base",
                &public_base,
                "--base",
                &members_base,
                "--output",
                local.to_str().unwrap(),
            ],
        ] {
            let output = ef(&arguments);
            assert!(output.status.success(), "{}", stderr(&output));
        }
        Self {
            _directory: directory,
            public,
            members,
            local,
            public_base,
            members_base,
        }
    }
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

#[test]
fn generates_a_protected_key_and_checkpoints_realms_independently() {
    let fixture = CheckpointFixture::new();
    assert_ne!(fixture.members_head, fixture.public_head);
    assert_ne!(fixture.second_public_head, fixture.public_head);
    let root = fixture.root();
    let status = ef(&["status", "--path", root]);
    assert!(status.status.success(), "{}", stderr(&status));
    let status = stdout(&status);
    assert!(status.contains(&format!(
        "checkpoint-head-public: {}\n",
        fixture.second_public_head
    )));
    assert!(status.contains("checkpoint-generation-public: 2\n"));
    assert!(status.contains(&format!(
        "checkpoint-head-members: {}\n",
        fixture.members_head
    )));
    assert!(status.contains("checkpoint-generation-members: 1\n"));
    assert!(status.contains(&format!("checkpoint-head-local: {}\n", fixture.local_head)));
    assert!(status.contains("checkpoint-generation-local: 1\n"));
}

#[test]
fn reads_history_and_working_diff_without_cross_realm_output() {
    let fixture = CheckpointFixture::new();
    let root = fixture.root();
    let public_history = ef(&[
        "history", "--path", root, "--realm", "public", "--limit", "1",
    ]);
    assert!(
        public_history.status.success(),
        "{}",
        stderr(&public_history)
    );
    let public_history = stdout(&public_history);
    assert!(public_history.contains("realm: public\n"));
    assert!(public_history.contains("entries: 1\n"));
    assert!(public_history.contains(&format!("change: {}\n", fixture.second_public_head)));
    assert!(public_history.contains("message: second\\npublic\\tmessage\\u{1b}\n"));
    assert!(!public_history.contains("members-only"));
    assert!(!public_history.contains(&fixture.members_head));

    let members_history = ef(&["history", "--path", root, "--realm", "members"]);
    assert!(
        members_history.status.success(),
        "{}",
        stderr(&members_history)
    );
    let members_history = stdout(&members_history);
    assert!(members_history.contains("message: members-only message\n"));
    assert!(!members_history.contains("public message"));

    let clean = ef(&["diff", "--path", root, "--realm", "public"]);
    assert!(clean.status.success(), "{}", stderr(&clean));
    assert!(stdout(&clean).contains("changes: 0\n"));

    fs::write(
        fixture.directory.as_ref().join("public.txt"),
        "public changed\n",
    )
    .unwrap();
    fs::write(
        fixture.directory.as_ref().join("members.txt"),
        "members changed\n",
    )
    .unwrap();
    let snapshot = ef(&["snapshot", "--path", root]);
    assert!(snapshot.status.success(), "{}", stderr(&snapshot));
    let public_diff = ef(&["diff", "--path", root, "--realm", "public"]);
    assert!(public_diff.status.success(), "{}", stderr(&public_diff));
    let public_diff = stdout(&public_diff);
    assert!(public_diff.contains("changes: 1\n"));
    assert!(public_diff.contains("M\tfile\tpublic.txt\n"));
    assert!(!public_diff.contains("members.txt"));
    assert!(!public_diff.contains("members-only"));

    let members_diff = ef(&["diff", "--path", root, "--realm", "members"]);
    assert!(members_diff.status.success(), "{}", stderr(&members_diff));
    let members_diff = stdout(&members_diff);
    assert!(members_diff.contains("changes: 1\n"));
    assert!(members_diff.contains("M\tfile\tmembers.txt\n"));
    assert!(!members_diff.contains("public.txt"));
}

#[test]
fn exports_and_offline_verifies_a_public_bundle_without_restricted_leakage() {
    let fixture = CheckpointFixture::new();
    fs::write(
        fixture.directory.as_ref().join("public.txt"),
        "unsigned-working-marker\n",
    )
    .unwrap();
    let snapshot = ef(&["snapshot", "--path", fixture.root()]);
    assert!(snapshot.status.success(), "{}", stderr(&snapshot));
    let output_directory = TestDirectory::new();
    let bundle = output_directory.as_ref().join("public.edge");
    let exported = ef(&[
        "export",
        "--path",
        fixture.root(),
        "--realm",
        "public",
        "--output",
        bundle.to_str().unwrap(),
    ]);
    assert!(exported.status.success(), "{}", stderr(&exported));
    let exported_stdout = stdout(&exported);
    assert!(exported_stdout.contains("realm: public\n"));
    assert!(exported_stdout.contains("semantic-root: sha256:"));
    assert!(bundle.join("manifest.cbor").is_file());

    let verified = ef(&["verify", bundle.to_str().unwrap()]);
    assert!(verified.status.success(), "{}", stderr(&verified));
    let verified_stdout = stdout(&verified);
    assert!(verified_stdout.contains("verification: ok\n"));
    assert!(verified_stdout.contains("realm: public\n"));
    assert!(!verified_stdout.contains("members-only"));
    assert!(!verified_stdout.contains(&fixture.members_head));

    for kind in ["artifacts", "blobs", "signatures"] {
        for entry in fs::read_dir(bundle.join(kind)).unwrap() {
            let body = fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("members-only"));
            assert!(!String::from_utf8_lossy(&body).contains("unsigned-working-marker"));
        }
    }

    let blob = fs::read_dir(bundle.join("blobs"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut body = fs::read(&blob).unwrap();
    body[0] ^= 1;
    fs::write(&blob, body).unwrap();
    let rejected = ef(&["verify", bundle.to_str().unwrap()]);
    assert!(!rejected.status.success());
    assert!(stderr(&rejected).contains("bundle object mismatch"));

    let members_bundle = output_directory.as_ref().join("members.edge");
    let members = ef(&[
        "export",
        "--path",
        fixture.root(),
        "--realm",
        "members",
        "--output",
        members_bundle.to_str().unwrap(),
    ]);
    assert!(!members.status.success());
    assert!(stderr(&members).contains("requires --base public=BUNDLE_DIRECTORY"));
    assert!(!members_bundle.exists());
}

#[test]
fn builds_a_deterministic_static_site_from_only_the_public_bundle() {
    let fixture = CheckpointFixture::new();
    let output_directory = TestDirectory::new();
    let bundle = output_directory.as_ref().join("public.edge");
    let first = output_directory.as_ref().join("site-first");
    let second = output_directory.as_ref().join("site-second");
    let exported = ef(&[
        "export",
        "--path",
        fixture.root(),
        "--realm",
        "public",
        "--output",
        bundle.to_str().unwrap(),
    ]);
    assert!(exported.status.success(), "{}", stderr(&exported));

    for site in [&first, &second] {
        let built = ef(&[
            "static-build",
            bundle.to_str().unwrap(),
            "--output",
            site.to_str().unwrap(),
        ]);
        assert!(built.status.success(), "{}", stderr(&built));
        assert!(stdout(&built).contains("realm: public\n"));
    }
    assert_eq!(directory_contents(&first), directory_contents(&second));
    assert!(first.join("index.html").is_file());
    assert!(first.join("history/page-0001.html").is_file());
    assert!(first.join("files/page-0001.html").is_file());
    assert!(first.join("edgefossil-site.json").is_file());
    assert!(!first.join("blobs").exists());
    let rendered = directory_contents(&first)
        .values()
        .flat_map(|body| body.iter().copied())
        .collect::<Vec<_>>();
    let rendered = String::from_utf8(rendered).unwrap();
    assert!(rendered.contains("public message"));
    assert!(!rendered.contains("members-only"));
    assert!(!rendered.contains("local-only"));

    let repeated = ef(&[
        "static-build",
        bundle.to_str().unwrap(),
        "--output",
        first.to_str().unwrap(),
    ]);
    assert!(!repeated.status.success());
    assert!(stderr(&repeated).contains("output already exists"));
}

#[test]
fn regenerates_an_identical_static_site_after_empty_repository_restore() {
    let fixture = CheckpointFixture::new();
    let source_bundles = ExportedBundles::from_repository(fixture.root());
    let output_directory = TestDirectory::new();
    let source_site = output_directory.as_ref().join("site-source");
    let restored_site = output_directory.as_ref().join("site-restored");

    let source_build = ef(&[
        "static-build",
        source_bundles.public.to_str().unwrap(),
        "--output",
        source_site.to_str().unwrap(),
    ]);
    assert!(source_build.status.success(), "{}", stderr(&source_build));

    let restored_repository = TestDirectory::new();
    let imported = ef(&[
        "import",
        source_bundles.public.to_str().unwrap(),
        "--path",
        restored_repository.as_ref().to_str().unwrap(),
    ]);
    assert!(imported.status.success(), "{}", stderr(&imported));
    let restored_bundle_directory = TestDirectory::new();
    let restored_bundle = restored_bundle_directory.as_ref().join("public.edge");
    let reexported = ef(&[
        "export",
        "--path",
        restored_repository.as_ref().to_str().unwrap(),
        "--realm",
        "public",
        "--output",
        restored_bundle.to_str().unwrap(),
    ]);
    assert!(reexported.status.success(), "{}", stderr(&reexported));
    assert_eq!(
        bundle_contents(&source_bundles.public),
        bundle_contents(&restored_bundle)
    );

    let restored_build = ef(&[
        "static-build",
        restored_bundle.to_str().unwrap(),
        "--output",
        restored_site.to_str().unwrap(),
    ]);
    assert!(
        restored_build.status.success(),
        "{}",
        stderr(&restored_build)
    );
    assert_eq!(
        output_value(&source_build, "semantic-root: "),
        output_value(&restored_build, "semantic-root: ")
    );
    assert_eq!(
        directory_contents(&source_site),
        directory_contents(&restored_site)
    );
}

#[test]
fn exports_and_verifies_composed_members_and_local_bundles() {
    let fixture = CheckpointFixture::new();
    let output_directory = TestDirectory::new();
    let public = output_directory.as_ref().join("public.edge");
    let members = output_directory.as_ref().join("members.edge");
    let local = output_directory.as_ref().join("local.edge");
    let public_base = format!("public={}", public.display());
    let members_base = format!("members={}", members.display());

    let export_public = ef(&[
        "export",
        "--path",
        fixture.root(),
        "--realm",
        "public",
        "--output",
        public.to_str().unwrap(),
    ]);
    assert!(export_public.status.success(), "{}", stderr(&export_public));
    let export_members = ef(&[
        "export",
        "--path",
        fixture.root(),
        "--realm",
        "members",
        "--base",
        &public_base,
        "--output",
        members.to_str().unwrap(),
    ]);
    assert!(
        export_members.status.success(),
        "{}",
        stderr(&export_members)
    );
    let verify_members = ef(&["verify", members.to_str().unwrap(), "--base", &public_base]);
    assert!(
        verify_members.status.success(),
        "{}",
        stderr(&verify_members)
    );
    assert!(stdout(&verify_members).contains("realm: members\n"));
    for kind in ["artifacts", "blobs", "signatures"] {
        for entry in fs::read_dir(members.join(kind)).unwrap() {
            let body = fs::read(entry.unwrap().path()).unwrap();
            let text = String::from_utf8_lossy(&body);
            assert!(!text.contains("public message"));
            assert!(!text.contains("local-only message"));
        }
    }

    let export_local = ef(&[
        "export",
        "--path",
        fixture.root(),
        "--realm",
        "local",
        "--base",
        &public_base,
        "--base",
        &members_base,
        "--output",
        local.to_str().unwrap(),
    ]);
    assert!(export_local.status.success(), "{}", stderr(&export_local));
    let verify_local = ef(&[
        "verify",
        local.to_str().unwrap(),
        "--base",
        &public_base,
        "--base",
        &members_base,
    ]);
    assert!(verify_local.status.success(), "{}", stderr(&verify_local));
    assert!(stdout(&verify_local).contains("realm: local\n"));
    for kind in ["artifacts", "blobs", "signatures"] {
        for entry in fs::read_dir(local.join(kind)).unwrap() {
            let body = fs::read(entry.unwrap().path()).unwrap();
            let text = String::from_utf8_lossy(&body);
            assert!(!text.contains("public message"));
            assert!(!text.contains("members-only message"));
        }
    }

    let mislabeled = format!("public={}", members.display());
    let rejected = ef(&["verify", members.to_str().unwrap(), "--base", &mislabeled]);
    assert!(!rejected.status.success());
    assert!(stderr(&rejected).contains("points to a members bundle"));
}

#[test]
fn imports_composed_bundles_into_empty_repository_and_reexports_exactly() {
    let fixture = CheckpointFixture::new();
    let bundles = ExportedBundles::from_repository(fixture.root());

    let restored = TestDirectory::new();
    let restored_path = restored.as_ref().to_str().unwrap();
    let public_import = ef(&[
        "import",
        bundles.public.to_str().unwrap(),
        "--path",
        restored_path,
    ]);
    assert!(public_import.status.success(), "{}", stderr(&public_import));
    assert!(stdout(&public_import).contains("imported-realm: public\n"));
    assert!(stdout(&public_import).contains("generation: 2\n"));
    let members_import = ef(&[
        "import",
        bundles.members.to_str().unwrap(),
        "--base",
        &bundles.public_base,
        "--path",
        restored_path,
    ]);
    assert!(
        members_import.status.success(),
        "{}",
        stderr(&members_import)
    );
    let local_import = ef(&[
        "import",
        bundles.local.to_str().unwrap(),
        "--base",
        &bundles.public_base,
        "--base",
        &bundles.members_base,
        "--path",
        restored_path,
    ]);
    assert!(local_import.status.success(), "{}", stderr(&local_import));

    let status = ef(&["status", "--path", restored_path]);
    assert!(status.status.success(), "{}", stderr(&status));
    let status = stdout(&status);
    assert!(status.contains(&format!(
        "checkpoint-head-public: {}\n",
        fixture.second_public_head
    )));
    assert!(status.contains(&format!(
        "checkpoint-head-members: {}\n",
        fixture.members_head
    )));
    assert!(status.contains(&format!("checkpoint-head-local: {}\n", fixture.local_head)));
    assert!(status.contains("tracking-project: 0\n"));
    assert!(status.contains("working-root-public: -\n"));
    assert!(status.contains("working-root-members: -\n"));
    assert!(status.contains("working-root-local: -\n"));

    let reexports = ExportedBundles::from_repository(restored_path);
    assert_eq!(
        bundle_contents(&reexports.public),
        bundle_contents(&bundles.public)
    );
    assert_eq!(
        bundle_contents(&reexports.members),
        bundle_contents(&bundles.members)
    );
    assert_eq!(
        bundle_contents(&reexports.local),
        bundle_contents(&bundles.local)
    );

    let repeated = ef(&[
        "import",
        bundles.public.to_str().unwrap(),
        "--path",
        restored_path,
    ]);
    assert!(!repeated.status.success());
    assert!(stderr(&repeated).contains("requires an empty repository database"));

    let blob = fs::read_dir(bundles.public.join("blobs"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut body = fs::read(&blob).unwrap();
    body[0] ^= 1;
    fs::write(blob, body).unwrap();
    let rejected_target = TestDirectory::new();
    let rejected = ef(&[
        "import",
        bundles.public.to_str().unwrap(),
        "--path",
        rejected_target.as_ref().to_str().unwrap(),
    ]);
    assert!(!rejected.status.success());
    assert!(!rejected_target.as_ref().join(".edgefossil").exists());
}

#[test]
fn rejects_wrong_or_repository_local_signing_keys_without_advancing_head() {
    let directory = TestDirectory::new();
    let key_directory = TestDirectory::new();
    let owner_key = key_directory.as_ref().join("owner.seed");
    let other_key = key_directory.as_ref().join("other.seed");
    let owner = ef(&["keygen", "--output", owner_key.to_str().unwrap()]);
    let other = ef(&["keygen", "--output", other_key.to_str().unwrap()]);
    assert!(owner.status.success(), "{}", stderr(&owner));
    assert!(other.status.success(), "{}", stderr(&other));
    let actor_key = output_value(&owner, "actor-key: ");
    let root = directory.as_ref().to_str().unwrap();
    let initialized = ef(&[
        "init",
        "--name",
        "Key boundaries",
        "--actor-key",
        &actor_key,
        "--path",
        root,
    ]);
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    fs::write(directory.as_ref().join("file.txt"), "content\n").unwrap();
    assert!(ef(&["track", "--path", root, "file.txt"]).status.success());
    assert!(ef(&["snapshot", "--path", root]).status.success());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&other_key, fs::Permissions::from_mode(0o644)).unwrap();
        let permissive = ef(&[
            "checkpoint",
            "--path",
            root,
            "--realm",
            "public",
            "-m",
            "must fail permissions",
            "--signing-key-file",
            other_key.to_str().unwrap(),
        ]);
        assert!(!permissive.status.success());
        assert!(stderr(&permissive).contains("use chmod 600"));
        fs::set_permissions(&other_key, fs::Permissions::from_mode(0o600)).unwrap();
    }

    let wrong = ef(&[
        "checkpoint",
        "--path",
        root,
        "--realm",
        "public",
        "-m",
        "must fail",
        "--signing-key-file",
        other_key.to_str().unwrap(),
    ]);
    assert!(!wrong.status.success());
    assert!(stderr(&wrong).contains("does not match the repository genesis actor key"));

    let repository_key = directory.as_ref().join("copied.seed");
    fs::copy(&owner_key, &repository_key).unwrap();
    let inside = ef(&[
        "checkpoint",
        "--path",
        root,
        "--realm",
        "public",
        "-m",
        "must also fail",
        "--signing-key-file",
        repository_key.to_str().unwrap(),
    ]);
    assert!(!inside.status.success());
    assert!(stderr(&inside).contains("must be stored outside the repository"));

    let status = ef(&["status", "--path", root]);
    assert!(stdout(&status).contains("checkpoint-head-public: -\n"));
    assert!(stdout(&status).contains("checkpoint-generation-public: 0\n"));
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
