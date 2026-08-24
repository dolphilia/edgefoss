//! Deterministic, provider-independent static projections of public bundles.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    fmt::Write as _,
};

use ef_format::{
    BundleManifest, ChangeArtifact, Realm, TreeArtifact, TreeEntryMode, decode_bundle_manifest,
    decode_change, decode_project_genesis, decode_tree,
};
use ef_store_sqlite::verify_portable_bundle;
use serde::Serialize;

/// Maximum number of logical records rendered into one HTML page.
pub const PAGE_SIZE: usize = 100;

/// Maximum current-tree content records packed into one static HTML asset.
pub const CONTENT_CHUNK_RECORDS: usize = 100;

/// Maximum rendered content-section bytes packed into one static HTML asset.
pub const CONTENT_CHUNK_BODY_BYTES: usize = 1024 * 1024;

/// Maximum raw UTF-8 file bytes embedded in the static snapshot.
pub const INLINE_TEXT_LIMIT_BYTES: usize = 64 * 1024;

/// A complete static output tree, keyed by portable relative path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaticSite {
    pub project: String,
    pub semantic_root: String,
    pub files: BTreeMap<String, Vec<u8>>,
}

/// A rejected static projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaticSiteError(String);

impl StaticSiteError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for StaticSiteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for StaticSiteError {}

#[derive(Clone, Debug)]
struct FileEntry {
    path: String,
    mode: TreeEntryMode,
    target: String,
    bytes: Option<usize>,
    content_href: Option<String>,
}

#[derive(Clone, Debug)]
struct ContentSection {
    id: String,
    html: String,
    inline: bool,
}

#[derive(Clone, Debug)]
struct ContentChunk {
    path: String,
    sections: Vec<ContentSection>,
    body_bytes: usize,
}

struct RenderModel<'a> {
    name: &'a str,
    project: &'a str,
    semantic_root: &'a str,
    history: &'a [(String, &'a ChangeArtifact)],
    current_files: &'a [FileEntry],
    history_pages: &'a [String],
    file_pages: &'a [String],
    content_chunks: &'a [ContentChunk],
}

type DecodedGraph = (
    BTreeMap<String, TreeArtifact>,
    BTreeMap<String, ChangeArtifact>,
);

#[derive(Serialize)]
struct SiteManifest<'a> {
    format: &'static str,
    version: u8,
    experimental: bool,
    source: SourceManifest<'a>,
    projection: ProjectionManifest,
    payloads: PayloadManifest,
}

#[derive(Serialize)]
struct SourceManifest<'a> {
    project: &'a str,
    realm: &'static str,
    semantic_root: &'a str,
}

#[derive(Serialize)]
struct ProjectionManifest {
    page_size: usize,
    history_items: usize,
    history_pages: Vec<String>,
    file_items: usize,
    file_pages: Vec<String>,
}

#[derive(Serialize)]
struct PayloadManifest {
    content_included: bool,
    delivery: &'static str,
    addressing: &'static str,
    object_count: usize,
    total_bytes: usize,
    inline_text_limit_bytes: usize,
    inline_text_objects: usize,
    external_objects: usize,
    chunk_record_limit: usize,
    chunk_body_limit_bytes: usize,
    chunks: Vec<ContentChunkManifest>,
}

#[derive(Serialize)]
struct ContentChunkManifest {
    path: String,
    objects: usize,
    body_bytes: usize,
}

/// Builds a byte-reproducible, read-only website from exactly one public bundle.
///
/// The bundle is deeply verified before any projection occurs. Small current
/// UTF-8 files are packed into bounded HTML chunks instead of one asset per
/// blob. Other blob bodies remain behind a content-addressed delivery boundary
/// for a later R2 or equivalent host integration.
///
/// # Errors
///
/// Rejects non-public, malformed, corrupt, or internally inconsistent bundles.
pub fn build_public_site(
    manifest_bytes: &[u8],
    objects: &BTreeMap<String, Vec<u8>>,
) -> Result<StaticSite, StaticSiteError> {
    let manifest = decode_bundle_manifest(manifest_bytes)
        .map_err(|error| StaticSiteError::new(format!("invalid bundle manifest: {error}")))?;
    if manifest.realm != Realm::Public {
        return Err(StaticSiteError::new(
            "static sites can only be generated from a public bundle",
        ));
    }
    let verified = verify_portable_bundle(manifest_bytes, objects, &[])
        .map_err(|error| StaticSiteError::new(format!("bundle verification failed: {error}")))?;

    project_site(&manifest, objects, &verified)
}

fn project_site(
    manifest: &BundleManifest,
    objects: &BTreeMap<String, Vec<u8>>,
    verified: &ef_store_sqlite::VerifiedBundle,
) -> Result<StaticSite, StaticSiteError> {
    let genesis = decode_project_genesis(artifact_body(objects, &manifest.project)?)
        .map_err(|error| StaticSiteError::new(format!("invalid project genesis: {error}")))?;
    let (trees, changes) = decode_graph(manifest, objects)?;
    let history = ordered_history(manifest, &changes)?;
    let head = history
        .first()
        .ok_or_else(|| StaticSiteError::new("public bundle history is empty"))?;
    let mut current_files = Vec::new();
    let mut active_trees = BTreeSet::new();
    flatten_tree(
        &head.1.root,
        "",
        &trees,
        objects,
        &mut active_trees,
        &mut current_files,
    )?;

    let content_chunks = build_content_chunks(&mut current_files, objects)?;
    let inline_ids = content_chunks
        .iter()
        .flat_map(|chunk| &chunk.sections)
        .filter(|section| section.inline)
        .map(|section| section.id.as_str())
        .collect::<BTreeSet<_>>();

    let history_pages = page_paths("history", history.len());
    let file_pages = page_paths("files", current_files.len());
    let mut files = render_site_files(&RenderModel {
        name: &genesis.name,
        project: verified.project(),
        semantic_root: verified.semantic_root(),
        history: &history,
        current_files: &current_files,
        history_pages: &history_pages,
        file_pages: &file_pages,
        content_chunks: &content_chunks,
    });
    let total_bytes = manifest
        .blobs
        .iter()
        .map(|id| blob_body(objects, id).map(Vec::len))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .sum();
    let site_manifest = SiteManifest {
        format: "edgefossil-static-site",
        version: 0,
        experimental: true,
        source: SourceManifest {
            project: verified.project(),
            realm: "public",
            semantic_root: verified.semantic_root(),
        },
        projection: ProjectionManifest {
            page_size: PAGE_SIZE,
            history_items: history.len(),
            history_pages,
            file_items: current_files.len(),
            file_pages,
        },
        payloads: PayloadManifest {
            content_included: !inline_ids.is_empty(),
            delivery: "bounded-static-chunks",
            addressing: "artifact-id",
            object_count: manifest.blobs.len(),
            total_bytes,
            inline_text_limit_bytes: INLINE_TEXT_LIMIT_BYTES,
            inline_text_objects: inline_ids.len(),
            external_objects: manifest.blobs.len() - inline_ids.len(),
            chunk_record_limit: CONTENT_CHUNK_RECORDS,
            chunk_body_limit_bytes: CONTENT_CHUNK_BODY_BYTES,
            chunks: content_chunks
                .iter()
                .map(|chunk| ContentChunkManifest {
                    path: chunk.path.clone(),
                    objects: chunk.sections.len(),
                    body_bytes: chunk.body_bytes,
                })
                .collect(),
        },
    };
    let mut encoded_manifest = serde_json::to_vec_pretty(&site_manifest)
        .map_err(|error| StaticSiteError::new(format!("cannot encode site manifest: {error}")))?;
    encoded_manifest.push(b'\n');
    files.insert("edgefossil-site.json".into(), encoded_manifest);

    Ok(StaticSite {
        project: verified.project().to_owned(),
        semantic_root: verified.semantic_root().to_owned(),
        files,
    })
}

fn render_site_files(model: &RenderModel<'_>) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    files.insert("assets/site.css".into(), SITE_CSS.as_bytes().to_vec());
    files.insert("_headers".into(), SECURITY_HEADERS.as_bytes().to_vec());
    files.insert("index.html".into(), render_index(model).into_bytes());
    files.insert("404.html".into(), render_not_found(model.name).into_bytes());
    for (index, chunk) in model.history.chunks(PAGE_SIZE).enumerate() {
        files.insert(
            model.history_pages[index].clone(),
            render_history_page(model.name, chunk, index, model.history_pages.len()).into_bytes(),
        );
    }
    for (index, chunk) in model.current_files.chunks(PAGE_SIZE).enumerate() {
        files.insert(
            model.file_pages[index].clone(),
            render_file_page(model.name, chunk, index, model.file_pages.len()).into_bytes(),
        );
    }
    if model.current_files.is_empty() {
        files.insert(
            model.file_pages[0].clone(),
            render_file_page(model.name, &[], 0, 1).into_bytes(),
        );
    }
    for chunk in model.content_chunks {
        files.insert(
            chunk.path.clone(),
            render_content_page(model.name, chunk).into_bytes(),
        );
    }
    files
}

fn decode_graph(
    manifest: &BundleManifest,
    objects: &BTreeMap<String, Vec<u8>>,
) -> Result<DecodedGraph, StaticSiteError> {
    let mut trees = BTreeMap::new();
    let mut changes = BTreeMap::new();
    for id in manifest
        .artifacts
        .iter()
        .filter(|id| *id != &manifest.project)
    {
        let body = artifact_body(objects, id)?;
        if let Ok(tree) = decode_tree(body) {
            trees.insert(id.clone(), tree);
        } else if let Ok(change) = decode_change(body) {
            changes.insert(id.clone(), change);
        } else {
            return Err(StaticSiteError::new(format!(
                "verified artifact has no supported static projection: {id}"
            )));
        }
    }
    Ok((trees, changes))
}

fn ordered_history<'a>(
    manifest: &BundleManifest,
    changes: &'a BTreeMap<String, ChangeArtifact>,
) -> Result<Vec<(String, &'a ChangeArtifact)>, StaticSiteError> {
    let mut next = manifest
        .refs
        .first()
        .ok_or_else(|| StaticSiteError::new("public bundle has no head"))?
        .1
        .clone();
    let mut history = Vec::new();
    while let Some(change) = changes.get(&next) {
        history.push((next.clone(), change));
        let Some(parent) = change.meta.parents.first() else {
            return Ok(history);
        };
        next.clone_from(parent);
    }
    Err(StaticSiteError::new(
        "verified history references an unavailable change",
    ))
}

fn flatten_tree(
    tree_id: &str,
    prefix: &str,
    trees: &BTreeMap<String, TreeArtifact>,
    objects: &BTreeMap<String, Vec<u8>>,
    active: &mut BTreeSet<String>,
    output: &mut Vec<FileEntry>,
) -> Result<(), StaticSiteError> {
    if !active.insert(tree_id.to_owned()) {
        return Err(StaticSiteError::new("tree projection contains a cycle"));
    }
    let tree = trees
        .get(tree_id)
        .ok_or_else(|| StaticSiteError::new(format!("missing tree projection: {tree_id}")))?;
    for entry in &tree.entries {
        let path = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{prefix}/{}", entry.name)
        };
        match entry.mode {
            TreeEntryMode::Directory => {
                output.push(FileEntry {
                    path: path.clone(),
                    mode: entry.mode,
                    target: entry.target.clone(),
                    bytes: None,
                    content_href: None,
                });
                flatten_tree(&entry.target, &path, trees, objects, active, output)?;
            }
            TreeEntryMode::File | TreeEntryMode::Executable => output.push(FileEntry {
                path,
                mode: entry.mode,
                target: entry.target.clone(),
                bytes: Some(blob_body(objects, &entry.target)?.len()),
                content_href: None,
            }),
            TreeEntryMode::Symlink => output.push(FileEntry {
                path,
                mode: entry.mode,
                target: entry.target.clone(),
                bytes: None,
                content_href: None,
            }),
        }
    }
    active.remove(tree_id);
    Ok(())
}

fn build_content_chunks(
    files: &mut [FileEntry],
    objects: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<ContentChunk>, StaticSiteError> {
    let mut paths_by_blob = BTreeMap::<String, Vec<String>>::new();
    for file in files.iter().filter(|file| file.bytes.is_some()) {
        paths_by_blob
            .entry(file.target.clone())
            .or_default()
            .push(file.path.clone());
    }

    let mut chunks = Vec::new();
    let mut pending = Vec::new();
    let mut pending_bytes = 0;
    for (id, paths) in paths_by_blob {
        let body = blob_body(objects, &id)?;
        let section = content_section(&id, &paths, body);
        let section_bytes = section.html.len();
        if section_bytes > CONTENT_CHUNK_BODY_BYTES {
            return Err(StaticSiteError::new(format!(
                "rendered content record exceeds chunk limit: {id}"
            )));
        }
        if !pending.is_empty()
            && (pending.len() == CONTENT_CHUNK_RECORDS
                || pending_bytes + section_bytes > CONTENT_CHUNK_BODY_BYTES)
        {
            chunks.push(finish_content_chunk(chunks.len(), pending, pending_bytes));
            pending = Vec::new();
            pending_bytes = 0;
        }
        pending_bytes += section_bytes;
        pending.push(section);
    }
    if !pending.is_empty() {
        chunks.push(finish_content_chunk(chunks.len(), pending, pending_bytes));
    }

    let href_by_blob = chunks
        .iter()
        .flat_map(|chunk| {
            chunk.sections.iter().map(|section| {
                (
                    section.id.as_str(),
                    format!("../{}#{}", chunk.path, content_anchor(&section.id)),
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    for file in files.iter_mut().filter(|file| file.bytes.is_some()) {
        file.content_href = href_by_blob.get(file.target.as_str()).cloned();
    }
    Ok(chunks)
}

fn content_section(id: &str, paths: &[String], body: &[u8]) -> ContentSection {
    let displayable = body.len() <= INLINE_TEXT_LIMIT_BYTES
        && std::str::from_utf8(body).is_ok_and(|text| {
            !text
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        });
    let first_path = paths.first().expect("content always has a current path");
    let path_list = if paths.len() == 1 {
        format!("<code>{}</code>", escape_html(first_path))
    } else {
        format!(
            "<code>{}</code> (+{} aliases)",
            escape_html(first_path),
            paths.len() - 1
        )
    };
    let content = if displayable {
        format!(
            "<pre>{}</pre>",
            escape_html(std::str::from_utf8(body).expect("displayable UTF-8 was checked"))
        )
    } else {
        "<p class=\"external\">Content is not embedded in this snapshot; retrieve it by artifact ID from an authorized content store.</p>".into()
    };
    ContentSection {
        id: id.to_owned(),
        html: format!(
            "<section class=\"content\" id=\"{}\"><h2>{}</h2><p>{} bytes · <code>{}</code></p>{}</section>",
            content_anchor(id),
            path_list,
            body.len(),
            escape_html(id),
            content
        ),
        inline: displayable,
    }
}

fn finish_content_chunk(
    index: usize,
    sections: Vec<ContentSection>,
    body_bytes: usize,
) -> ContentChunk {
    ContentChunk {
        path: format!("content/chunk-{:04}.html", index + 1),
        sections,
        body_bytes,
    }
}

fn content_anchor(id: &str) -> String {
    format!("blob-{}", id.strip_prefix("sha256:").unwrap_or(id))
}

fn artifact_body<'a>(
    objects: &'a BTreeMap<String, Vec<u8>>,
    id: &str,
) -> Result<&'a Vec<u8>, StaticSiteError> {
    object_body(objects, "artifacts", "cbor", id)
}

fn blob_body<'a>(
    objects: &'a BTreeMap<String, Vec<u8>>,
    id: &str,
) -> Result<&'a Vec<u8>, StaticSiteError> {
    object_body(objects, "blobs", "bin", id)
}

fn object_body<'a>(
    objects: &'a BTreeMap<String, Vec<u8>>,
    kind: &str,
    extension: &str,
    id: &str,
) -> Result<&'a Vec<u8>, StaticSiteError> {
    let digest = id
        .strip_prefix("sha256:")
        .ok_or_else(|| StaticSiteError::new("verified object ID has an invalid prefix"))?;
    objects
        .get(&format!("{kind}/{digest}.{extension}"))
        .ok_or_else(|| StaticSiteError::new(format!("verified object is unavailable: {id}")))
}

fn page_paths(section: &str, item_count: usize) -> Vec<String> {
    let pages = item_count.max(1).div_ceil(PAGE_SIZE);
    (1..=pages)
        .map(|page| format!("{section}/page-{page:04}.html"))
        .collect()
}

fn render_index(model: &RenderModel<'_>) -> String {
    format!(
        "{}<main><p class=\"eyebrow\">EdgeFossil public snapshot</p><h1>{}</h1><dl><dt>Project</dt><dd><code>{}</code></dd><dt>Semantic root</dt><dd><code>{}</code></dd></dl><nav><a href=\"{}\">History <strong>{}</strong></a><a href=\"{}\">Files <strong>{}</strong></a></nav><section class=\"timeline\"><p class=\"eyebrow\">Recent timeline</p>{}</section></main>{}",
        page_head(model.name, "assets/site.css"),
        escape_html(model.name),
        escape_html(model.project),
        escape_html(model.semantic_root),
        model.history_pages[0],
        model.history.len(),
        model.file_pages[0],
        model.current_files.len(),
        render_timeline(model.history),
        PAGE_FOOT
    )
}

fn render_timeline(history: &[(String, &ChangeArtifact)]) -> String {
    let mut rows = String::new();
    for (id, change) in history.iter().take(5) {
        let _ = write!(
            rows,
            "<article><h2>{}</h2><p><time>{}</time> · logical clock {}</p><code>{}</code></article>",
            escape_html(&change.message),
            escape_html(&change.meta.created_at),
            change.meta.logical_clock,
            escape_html(id)
        );
    }
    rows
}

fn render_not_found(name: &str) -> String {
    format!(
        "{}<main><p class=\"eyebrow\">404 · Not found</p><h1>{}</h1><p>This public snapshot does not contain the requested page.</p><a href=\"/\">Return to the project</a></main>{}",
        page_head(name, "/assets/site.css"),
        escape_html(name),
        PAGE_FOOT
    )
}

fn render_history_page(
    name: &str,
    entries: &[(String, &ChangeArtifact)],
    page: usize,
    pages: usize,
) -> String {
    let mut rows = String::new();
    for (id, change) in entries {
        let _ = write!(
            rows,
            "<article><h2>{}</h2><p><time>{}</time> · logical clock {}</p><code>{}</code></article>",
            escape_html(&change.message),
            escape_html(&change.meta.created_at),
            change.meta.logical_clock,
            escape_html(id)
        );
    }
    format!(
        "{}<main><a href=\"../index.html\">← Project</a><p class=\"eyebrow\">History · page {} of {}</p><h1>{}</h1>{}<p class=\"pager\">{}</p></main>{}",
        page_head(name, "../assets/site.css"),
        page + 1,
        pages,
        escape_html(name),
        rows,
        pagination("history", page, pages),
        PAGE_FOOT
    )
}

fn render_file_page(name: &str, entries: &[FileEntry], page: usize, pages: usize) -> String {
    let mut rows = String::new();
    for entry in entries {
        let mode = match entry.mode {
            TreeEntryMode::File => "file",
            TreeEntryMode::Executable => "executable",
            TreeEntryMode::Directory => "directory",
            TreeEntryMode::Symlink => "symlink",
        };
        let detail = entry.bytes.map_or_else(
            || entry.target.clone(),
            |bytes| format!("{bytes} bytes · {}", entry.target),
        );
        let path = entry.content_href.as_ref().map_or_else(
            || format!("<code>{}</code>", escape_html(&entry.path)),
            |href| {
                format!(
                    "<a href=\"{}\"><code>{}</code></a>",
                    escape_html(href),
                    escape_html(&entry.path)
                )
            },
        );
        let _ = write!(
            rows,
            "<tr><td>{}</td><td>{}</td><td><code>{}</code></td></tr>",
            path,
            mode,
            escape_html(&detail)
        );
    }
    format!(
        "{}<main><a href=\"../index.html\">← Project</a><p class=\"eyebrow\">Files · page {} of {}</p><h1>{}</h1><table><thead><tr><th>Path</th><th>Mode</th><th>Target</th></tr></thead><tbody>{}</tbody></table><p class=\"pager\">{}</p></main>{}",
        page_head(name, "../assets/site.css"),
        page + 1,
        pages,
        escape_html(name),
        rows,
        pagination("files", page, pages),
        PAGE_FOOT
    )
}

fn render_content_page(name: &str, chunk: &ContentChunk) -> String {
    let body = chunk
        .sections
        .iter()
        .map(|section| section.html.as_str())
        .collect::<String>();
    format!(
        "{}<main><a href=\"../index.html\">← Project</a><p class=\"eyebrow\">File contents · {} objects</p><h1>{}</h1>{}</main>{}",
        page_head(name, "../assets/site.css"),
        chunk.sections.len(),
        escape_html(name),
        body,
        PAGE_FOOT
    )
}

fn pagination(section: &str, page: usize, pages: usize) -> String {
    let mut links = String::new();
    if page > 0 {
        let _ = write!(links, "<a href=\"page-{page:04}.html\">← Previous</a> ");
    }
    if page + 1 < pages {
        let next = page + 2;
        let _ = write!(links, "<a href=\"page-{next:04}.html\">Next →</a>");
    }
    if links.is_empty() {
        format!("All {section} fit on this page.")
    } else {
        links
    }
}

fn page_head(title: &str, stylesheet: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><title>{} · EdgeFossil</title><link rel=\"stylesheet\" href=\"{}\"></head><body>",
        escape_html(title),
        stylesheet
    )
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

const PAGE_FOOT: &str =
    "<footer>Generated from a deeply verified public bundle. Read-only.</footer></body></html>\n";
const SECURITY_HEADERS: &str = "/*\n  Content-Security-Policy: default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n";
const SITE_CSS: &str = "*{box-sizing:border-box}body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.55;margin:0;color:#17211b;background:#f5f7f3}main,footer{max-width:72rem;margin:auto;padding:2rem}h1{font-size:clamp(2rem,6vw,4rem);margin:.2rem 0 2rem}.eyebrow{letter-spacing:.12em;text-transform:uppercase;color:#476254}dl{display:grid;grid-template-columns:max-content 1fr;gap:.6rem 1rem}dd{margin:0;overflow-wrap:anywhere}nav{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem;margin-top:3rem}nav a,article,.content{border:1px solid #aebbb3;border-radius:.6rem;padding:1rem;background:#fff}nav strong{display:block;font-size:2rem}a{color:#16643b}article,.content{margin:1rem 0}article h2,.content h2{margin:0;overflow-wrap:anywhere}code{overflow-wrap:anywhere}pre{overflow:auto;padding:1rem;background:#edf1ed;border-radius:.4rem}.external{border-left:.25rem solid #b36b00;padding-left:1rem}table{width:100%;border-collapse:collapse;background:#fff}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #ccd4cf;padding:.7rem}.pager{min-height:1.5rem}footer{color:#5b685f}@media(prefers-color-scheme:dark){body{color:#e8eee9;background:#111713}nav a,article,.content,table{background:#18211b;border-color:#46534a}pre{background:#101611}a{color:#8ee3ae}th,td{border-color:#46534a}}\n";

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};
    use edgefoss_core::{SnapshotInput, SnapshotInputKind, build_realm_snapshots};
    use ef_format::{
        ArtifactMeta, ChangeArtifact, ProjectGenesis, SignatureRecord, artifact_id,
        artifact_signature_message, encode_change,
    };
    use ef_store_sqlite::{LocalRepository, PortableBundle};

    use super::{
        CONTENT_CHUNK_BODY_BYTES, CONTENT_CHUNK_RECORDS, INLINE_TEXT_LIMIT_BYTES, PAGE_SIZE,
        build_public_site,
    };

    fn sign(key: &SigningKey, artifact: &str) -> SignatureRecord {
        SignatureRecord {
            artifact: artifact.into(),
            actor_key: key.verifying_key().to_bytes(),
            signature: key
                .sign(&artifact_signature_message(artifact).unwrap())
                .to_bytes(),
        }
    }

    fn public_fixture() -> (LocalRepository, SigningKey, PortableBundle) {
        let key = SigningKey::from_bytes(&[23; 32]);
        let genesis = ProjectGenesis {
            name: "Static <project>".into(),
            nonce: [24; 32],
            actor_key: key.verifying_key().to_bytes(),
            created_at: "2026-08-25T00:00:00Z".into(),
        };
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let project = repository.init_project(&genesis).unwrap();
        let mut inputs = (0..(PAGE_SIZE * 2 + 5))
            .map(|index| SnapshotInput {
                path: format!("public/file-{index:03}.txt"),
                realm: Realm::Public,
                kind: SnapshotInputKind::File {
                    bytes: if index == 0 {
                        b"public <script>safe</script>".to_vec()
                    } else {
                        format!("public-{index}").into_bytes()
                    },
                    executable: false,
                },
            })
            .collect::<Vec<_>>();
        inputs.push(SnapshotInput {
            path: "public/binary.bin".into(),
            realm: Realm::Public,
            kind: SnapshotInputKind::File {
                bytes: vec![0, 1, 2, 255],
                executable: false,
            },
        });
        inputs.push(SnapshotInput {
            path: "public/alias.txt".into(),
            realm: Realm::Public,
            kind: SnapshotInputKind::File {
                bytes: b"public-1".to_vec(),
                executable: false,
            },
        });
        inputs.push(SnapshotInput {
            path: "public/large.txt".into(),
            realm: Realm::Public,
            kind: SnapshotInputKind::File {
                bytes: vec![b'L'; INLINE_TEXT_LIMIT_BYTES + 1],
                executable: false,
            },
        });
        inputs.push(SnapshotInput {
            path: "members/secret.txt".into(),
            realm: Realm::Members,
            kind: SnapshotInputKind::File {
                bytes: b"members-private-marker".to_vec(),
                executable: false,
            },
        });
        inputs.push(SnapshotInput {
            path: "local/device.txt".into(),
            realm: Realm::Local,
            kind: SnapshotInputKind::File {
                bytes: b"local-private-marker".to_vec(),
                executable: false,
            },
        });
        let snapshots =
            build_realm_snapshots(&project, genesis.actor_key, &genesis.created_at, &inputs)
                .unwrap();
        repository
            .replace_working_snapshots(&snapshots, "2026-08-25T00:00:01Z")
            .unwrap();
        let basis = repository.checkpoint_basis(Realm::Public).unwrap();
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
            message: "publish <safe>".into(),
        };
        let change_id = artifact_id(&encode_change(&change).unwrap());
        let mut ids = basis.artifacts_to_sign;
        ids.push(change_id);
        let signatures = ids.iter().map(|id| sign(&key, id)).collect::<Vec<_>>();
        repository
            .commit_checkpoint(&change, basis.expected_generation, &signatures)
            .unwrap();
        let public = repository.export_bundle(Realm::Public, &[]).unwrap();
        (repository, key, public)
    }

    #[test]
    fn public_projection_is_deterministic_paged_and_realm_isolated() {
        let (_, _, public) = public_fixture();
        let first = build_public_site(&public.manifest_bytes, &public.objects).unwrap();
        let second = build_public_site(&public.manifest_bytes, &public.objects).unwrap();
        assert_eq!(first, second);
        assert!(first.files.contains_key("files/page-0003.html"));
        assert!(first.files.contains_key("content/chunk-0003.html"));
        assert!(!first.files.contains_key("content/chunk-0004.html"));
        assert!(first.files.contains_key("404.html"));
        assert!(!first.files.keys().any(|path| path.starts_with("blobs/")));
        let joined = first
            .files
            .values()
            .flat_map(|body| body.iter().copied())
            .collect::<Vec<_>>();
        let text = String::from_utf8(joined).unwrap();
        assert!(!text.contains("members-private-marker"));
        assert!(!text.contains("local-private-marker"));
        assert!(text.contains("Static &lt;project&gt;"));
        assert!(text.contains("publish &lt;safe&gt;"));
        assert!(text.contains("public &lt;script&gt;safe&lt;/script&gt;"));
        assert!(!text.contains("public <script>safe</script>"));
        assert!(text.contains("Recent timeline"));
        assert!(text.contains("Content is not embedded in this snapshot"));
        assert!(text.contains("(+1 aliases)"));

        let manifest: serde_json::Value =
            serde_json::from_slice(&first.files["edgefossil-site.json"]).unwrap();
        assert_eq!(manifest["payloads"]["delivery"], "bounded-static-chunks");
        assert_eq!(manifest["payloads"]["inline_text_objects"], 205);
        assert_eq!(manifest["payloads"]["external_objects"], 2);
        assert_eq!(
            manifest["payloads"]["chunk_record_limit"],
            CONTENT_CHUNK_RECORDS
        );
        assert_eq!(
            manifest["payloads"]["chunk_body_limit_bytes"],
            CONTENT_CHUNK_BODY_BYTES
        );
        assert_eq!(manifest["payloads"]["chunks"].as_array().unwrap().len(), 3);
        for chunk in manifest["payloads"]["chunks"].as_array().unwrap() {
            assert!(chunk["objects"].as_u64().unwrap() <= CONTENT_CHUNK_RECORDS as u64);
            assert!(chunk["body_bytes"].as_u64().unwrap() <= CONTENT_CHUNK_BODY_BYTES as u64);
        }
    }

    #[test]
    fn projection_rejects_corrupt_and_non_public_bundles() {
        let (mut repository, key, public) = public_fixture();
        let mut corrupt = public.objects.clone();
        let blob = corrupt
            .iter_mut()
            .find(|(path, _)| path.starts_with("blobs/"))
            .unwrap()
            .1;
        blob[0] ^= 1;
        assert!(build_public_site(&public.manifest_bytes, &corrupt).is_err());

        let members_basis = repository.checkpoint_basis(Realm::Members).unwrap();
        let members_change = ChangeArtifact {
            meta: ArtifactMeta {
                project: members_basis.project.clone(),
                realm: Realm::Members,
                parents: vec![],
                actor_key: members_basis.actor_key,
                logical_clock: members_basis.logical_clock,
                created_at: "2026-08-25T00:00:03Z".into(),
            },
            root: members_basis.root.clone(),
            message: "members-only".into(),
        };
        let members_change_id = artifact_id(&encode_change(&members_change).unwrap());
        let mut members_ids = members_basis.artifacts_to_sign;
        members_ids.push(members_change_id);
        let members_signatures = members_ids
            .iter()
            .map(|id| sign(&key, id))
            .collect::<Vec<_>>();
        repository
            .commit_checkpoint(
                &members_change,
                members_basis.expected_generation,
                &members_signatures,
            )
            .unwrap();
        let members = repository
            .export_bundle(
                Realm::Members,
                &[(Realm::Public, public.manifest.semantic_root.clone())],
            )
            .unwrap();
        assert_eq!(
            build_public_site(&members.manifest_bytes, &members.objects)
                .unwrap_err()
                .to_string(),
            "static sites can only be generated from a public bundle"
        );
    }

    use ef_format::Realm;
}
