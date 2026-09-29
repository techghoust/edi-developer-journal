use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

const PROTOCOL_VERSION: u64 = 1;
const MAX_BODY_BYTES: usize = 96 * 1024;
const MAX_SELECTION_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRef {
    pub workspace_path: String,
    pub repository_path: Option<String>,
    pub git_common_dir: Option<String>,
    pub remote_url: Option<String>,
    pub head_commit: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientIdentity {
    id: String,
    version: String,
}

#[derive(Debug, Deserialize)]
struct Position {
    line: u64,
    character: u64,
}

#[derive(Debug, Deserialize)]
struct SourceSelection {
    text: Option<String>,
    start: Position,
    end: Position,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceContext {
    file_path: String,
    workspace_relative_path: Option<String>,
    language_id: String,
    selection: SourceSelection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope {
    protocol_version: u64,
    request_id: String,
    action: String,
    client: ClientIdentity,
    project: ProjectRef,
    source: Option<SourceContext>,
    #[serde(default)]
    payload: Value,
}

pub(crate) struct IntegrationRuntime {
    descriptor_path: PathBuf,
}

impl Drop for IntegrationRuntime {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.descriptor_path);
    }
}

fn integration_directory() -> Result<PathBuf, String> {
    let config = dirs::config_dir().ok_or("Cannot resolve application data directory.")?;
    Ok(config.join("EDI Developer Journal"))
}

fn write_descriptor(
    path: &PathBuf,
    port: u16,
    token: &str,
    instance_id: &str,
) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(&json!({
        "protocolVersion": PROTOCOL_VERSION,
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "instanceId": instance_id,
    }))
    .map_err(|error| error.to_string())?;
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn secure_equals(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn header_value(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_string())
}

fn response(value: Value, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| {
        b"{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Failed to encode response.\"}}"
            .to_vec()
    });
    let content_type = Header::from_bytes("Content-Type", "application/json; charset=utf-8")
        .expect("valid content type header");
    let cache_control =
        Header::from_bytes("Cache-Control", "no-store").expect("valid cache header");
    Response::from_data(body)
        .with_status_code(StatusCode(status))
        .with_header(content_type)
        .with_header(cache_control)
}

fn error_response(
    request_id: &str,
    code: &str,
    message: &str,
    retryable: bool,
    status: u16,
) -> Response<std::io::Cursor<Vec<u8>>> {
    response(
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "ok": false,
            "error": { "code": code, "message": message, "retryable": retryable }
        }),
        status,
    )
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn queue_integration_ui(
    app: &AppHandle,
    pending: &Arc<Mutex<Option<Value>>>,
    envelope: &RequestEnvelope,
    project: Option<Value>,
    focus: bool,
) -> Result<(), (String, String, bool, u16)> {
    let preferred_path = envelope
        .project
        .repository_path
        .as_ref()
        .unwrap_or(&envelope.project.workspace_path);
    let suggested_name = std::path::Path::new(preferred_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project");
    let ui_request = json!({
        "requestId": envelope.request_id,
        "action": envelope.action,
        "project": project,
        "workspacePath": envelope.project.workspace_path,
        "repositoryPath": envelope.project.repository_path,
        "gitCommonDir": envelope.project.git_common_dir,
        "branch": envelope.project.branch,
        "suggestedName": suggested_name,
    });
    *pending.lock().map_err(|_| {
        (
            "INTERNAL_ERROR".into(),
            "Integration queue failed.".into(),
            true,
            500,
        )
    })? = Some(ui_request);
    if focus {
        show_main_window(app);
    }
    let _ = app.emit("edi-integration-request", ());
    Ok(())
}

fn source_label(source: &SourceContext) -> String {
    let path = source
        .workspace_relative_path
        .as_deref()
        .unwrap_or(&source.file_path);
    let first = source.selection.start.line + 1;
    let last = source.selection.end.line + 1;
    if first == last {
        format!("{path}:{first}")
    } else {
        format!("{path}:{first}-{last}")
    }
}

fn source_details(source: Option<&SourceContext>) -> String {
    let Some(source) = source else {
        return String::new();
    };
    let mut details = format!("Source: {} ({})", source_label(source), source.language_id);
    if let Some(selection) = source
        .selection
        .text
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        details.push_str("\n\nSelected code:\n\n");
        for line in selection.lines() {
            details.push_str("    ");
            details.push_str(line);
            details.push('\n');
        }
    }
    details
}

fn combined_details(comment: &str, source: Option<&SourceContext>) -> String {
    let source = source_details(source);
    match (comment.is_empty(), source.is_empty()) {
        (true, true) => String::new(),
        (false, true) => comment.to_string(),
        (true, false) => source,
        (false, false) => format!("{comment}\n\n{source}"),
    }
}

fn validate_create_request(envelope: &RequestEnvelope) -> Result<(&str, &str, &str), String> {
    let entry_type = envelope
        .payload
        .get("entryType")
        .and_then(Value::as_str)
        .ok_or("Entry type is required.")?;
    if !matches!(entry_type, "note" | "decision" | "experiment" | "research") {
        return Err("Unsupported entry type.".into());
    }
    let title = envelope
        .payload
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("Entry title must contain 1 to 200 characters.".into());
    }
    let comment = envelope
        .payload
        .get("comment")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if comment.chars().count() > 10_000 {
        return Err("Entry comment must not exceed 10,000 characters.".into());
    }
    if envelope.client.id.is_empty()
        || envelope.client.id.len() > 100
        || envelope.client.version.is_empty()
        || envelope.client.version.len() > 100
    {
        return Err("Invalid integration client identity.".into());
    }
    if envelope
        .source
        .as_ref()
        .and_then(|source| source.selection.text.as_ref())
        .is_some_and(|text| text.len() > MAX_SELECTION_BYTES)
    {
        return Err("Selected code must not exceed 64 KiB.".into());
    }
    Ok((entry_type, title, comment))
}

fn create_integration_entry(
    db: &Connection,
    envelope: &RequestEnvelope,
    project_id: &str,
) -> Result<Value, String> {
    let previous: Option<String> = db
        .query_row(
            "SELECT response_json FROM integration_requests WHERE request_id=?1",
            [&envelope.request_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(previous) = previous {
        let mut result: Value =
            serde_json::from_str(&previous).map_err(|error| error.to_string())?;
        result["created"] = Value::Bool(false);
        result["duplicate"] = Value::Bool(true);
        return Ok(result);
    }

    let (entry_type, title, comment) = validate_create_request(envelope)?;
    let details = combined_details(comment, envelope.source.as_ref());
    let source_file = envelope.source.as_ref().map(|source| {
        source
            .workspace_relative_path
            .clone()
            .unwrap_or_else(|| source.file_path.clone())
    });
    let file_paths = source_file
        .as_ref()
        .map(|path| json!([path]))
        .unwrap_or_else(|| json!([]));
    let commit_hashes = envelope
        .project
        .head_commit
        .as_ref()
        .map(|hash| json!([hash]))
        .unwrap_or_else(|| json!([]));

    let transaction = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let input = match entry_type {
        "note" => json!({
            "projectId": project_id,
            "title": title,
            "bodyMd": details,
            "commitHashes": commit_hashes,
        }),
        "decision" => json!({
            "projectId": project_id,
            "title": title,
            "status": "active",
            "reason": comment,
            "notes": source_details(envelope.source.as_ref()),
            "filePaths": file_paths,
            "commitHashes": commit_hashes,
        }),
        "experiment" => json!({
            "projectId": project_id,
            "title": title,
            "status": "planned",
            "hypothesis": comment,
            "tested": envelope.source.as_ref().map(source_label).unwrap_or_default(),
            "notes": source_details(envelope.source.as_ref()),
            "filePaths": file_paths,
            "commitHashes": commit_hashes,
        }),
        "research" => json!({
            "projectId": project_id,
            "type": "note",
            "title": title,
            "pathOrUrl": Value::Null,
            "notes": details,
        }),
        _ => unreachable!(),
    };
    let record = match entry_type {
        "note" => crate::create_entry_record(&transaction, &input)?,
        "decision" => crate::create_decision_record(&transaction, &input)?,
        "experiment" => crate::create_experiment_record(&transaction, &input)?,
        "research" => crate::create_research_record(&transaction, &input)?,
        _ => unreachable!(),
    };
    let entry_id = record
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Created entry has no identifier.")?;
    let source = envelope.source.as_ref();
    transaction
        .execute(
            "INSERT INTO integration_sources(project_id,memory_kind,memory_id,client_id,client_version,file_path,workspace_relative_path,language_id,start_line,start_character,end_line,end_character,selected_text,branch,head_commit) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                project_id,
                entry_type,
                entry_id,
                envelope.client.id,
                envelope.client.version,
                source.map(|item| item.file_path.as_str()),
                source.and_then(|item| item.workspace_relative_path.as_deref()),
                source.map(|item| item.language_id.as_str()),
                source.map(|item| item.selection.start.line as i64),
                source.map(|item| item.selection.start.character as i64),
                source.map(|item| item.selection.end.line as i64),
                source.map(|item| item.selection.end.character as i64),
                source.and_then(|item| item.selection.text.as_deref()),
                envelope.project.branch,
                envelope.project.head_commit,
            ],
        )
        .map_err(|error| error.to_string())?;
    let result = json!({
        "projectId": project_id,
        "entryId": entry_id,
        "entryType": entry_type,
        "created": true,
        "duplicate": false,
    });
    let serialized = serde_json::to_string(&result).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO integration_requests(request_id,client_id,client_version,action,response_json) VALUES(?1,?2,?3,?4,?5)",
            params![
                envelope.request_id,
                envelope.client.id,
                envelope.client.version,
                envelope.action,
                serialized,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM integration_requests WHERE request_id NOT IN (SELECT request_id FROM integration_requests ORDER BY datetime(created_at) DESC,rowid DESC LIMIT 1000)",
            [],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

fn handle_project_open(
    app: &AppHandle,
    database: &Arc<Mutex<Option<Connection>>>,
    database_error: &Option<String>,
    pending: &Arc<Mutex<Option<Value>>>,
    envelope: &RequestEnvelope,
) -> Result<Value, (String, String, bool, u16)> {
    let guard = database.lock().map_err(|_| {
        (
            "INTERNAL_ERROR".into(),
            "Database lock failed.".into(),
            true,
            500,
        )
    })?;
    let db = guard.as_ref().ok_or_else(|| {
        (
            "DATABASE_UNAVAILABLE".into(),
            database_error
                .clone()
                .unwrap_or_else(|| "Database unavailable.".into()),
            true,
            503,
        )
    })?;
    let project = crate::resolve_integration_project(db, &envelope.project)
        .map_err(|message| ("PROJECT_RESOLUTION_FAILED".into(), message, false, 500))?;
    drop(guard);

    let project_id = project
        .as_ref()
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str);
    queue_integration_ui(app, pending, envelope, project.clone(), true)?;
    Ok(json!({
        "projectId": project_id,
        "opened": project_id.is_some(),
        "needsLink": project_id.is_none(),
    }))
}

fn handle_entry_create(
    app: &AppHandle,
    database: &Arc<Mutex<Option<Connection>>>,
    database_error: &Option<String>,
    pending: &Arc<Mutex<Option<Value>>>,
    envelope: &RequestEnvelope,
) -> Result<Value, (String, String, bool, u16)> {
    let guard = database.lock().map_err(|_| {
        (
            "INTERNAL_ERROR".into(),
            "Database lock failed.".into(),
            true,
            500,
        )
    })?;
    let db = guard.as_ref().ok_or_else(|| {
        (
            "DATABASE_UNAVAILABLE".into(),
            database_error
                .clone()
                .unwrap_or_else(|| "Database unavailable.".into()),
            true,
            503,
        )
    })?;
    let project = crate::resolve_integration_project(db, &envelope.project)
        .map_err(|message| ("PROJECT_RESOLUTION_FAILED".into(), message, false, 500))?;
    let Some(project) = project else {
        drop(guard);
        queue_integration_ui(app, pending, envelope, None, true)?;
        return Err((
            "PROJECT_NOT_LINKED".into(),
            "This workspace is not linked to an EDI project yet.".into(),
            false,
            409,
        ));
    };
    let project_id = project.get("id").and_then(Value::as_str).ok_or_else(|| {
        (
            "INTERNAL_ERROR".into(),
            "Resolved project has no identifier.".into(),
            false,
            500,
        )
    })?;
    let result = create_integration_entry(db, envelope, project_id)
        .map_err(|message| ("INVALID_REQUEST".into(), message, false, 400))?;
    drop(guard);
    queue_integration_ui(app, pending, envelope, Some(project), false)?;
    Ok(result)
}

fn handle_request(
    mut request: Request,
    app: &AppHandle,
    database: &Arc<Mutex<Option<Connection>>>,
    database_error: &Option<String>,
    pending: &Arc<Mutex<Option<Value>>>,
    token: &str,
    instance_id: &str,
) {
    if request.method() == &Method::Get && request.url() == "/v1/health" {
        let _ = request.respond(response(
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "instanceId": instance_id,
                "pid": std::process::id(),
            }),
            200,
        ));
        return;
    }

    if request.method() != &Method::Post || request.url() != "/v1/requests" {
        let _ = request.respond(error_response(
            "",
            "ACTION_NOT_SUPPORTED",
            "Unknown EDI integration endpoint.",
            false,
            404,
        ));
        return;
    }
    if header_value(&request, "Origin").is_some() {
        let _ = request.respond(error_response(
            "",
            "UNAUTHORIZED",
            "Browser-origin requests are not accepted.",
            false,
            403,
        ));
        return;
    }
    let expected = format!("Bearer {token}");
    if !header_value(&request, "Authorization")
        .is_some_and(|provided| secure_equals(&provided, &expected))
    {
        let _ = request.respond(error_response(
            "",
            "UNAUTHORIZED",
            "Invalid EDI integration token.",
            false,
            401,
        ));
        return;
    }
    if !header_value(&request, "Content-Type")
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"))
    {
        let _ = request.respond(error_response(
            "",
            "INVALID_REQUEST",
            "Content-Type must be application/json.",
            false,
            415,
        ));
        return;
    }

    let mut bytes = Vec::new();
    if request
        .as_reader()
        .take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        let _ = request.respond(error_response(
            "",
            "INVALID_REQUEST",
            "Failed to read request body.",
            false,
            400,
        ));
        return;
    }
    if bytes.len() > MAX_BODY_BYTES {
        let _ = request.respond(error_response(
            "",
            "PAYLOAD_TOO_LARGE",
            "EDI integration payload is too large.",
            false,
            413,
        ));
        return;
    }
    let envelope: RequestEnvelope = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            let _ = request.respond(error_response(
                "",
                "INVALID_REQUEST",
                "Malformed EDI integration request.",
                false,
                400,
            ));
            return;
        }
    };
    if envelope.protocol_version != PROTOCOL_VERSION {
        let _ = request.respond(error_response(
            &envelope.request_id,
            "UNSUPPORTED_PROTOCOL",
            "EDI supports Integration Protocol v1.",
            false,
            409,
        ));
        return;
    }
    if envelope.request_id.is_empty() || envelope.request_id.len() > 128 {
        let _ = request.respond(error_response(
            "",
            "INVALID_REQUEST",
            "Invalid request identifier.",
            false,
            400,
        ));
        return;
    }

    let result = match envelope.action.as_str() {
        "project.open" => handle_project_open(app, database, database_error, pending, &envelope),
        "entry.create" => handle_entry_create(app, database, database_error, pending, &envelope),
        _ => Err((
            "ACTION_NOT_SUPPORTED".into(),
            "This action is not supported by EDI.".into(),
            false,
            404,
        )),
    };
    let outgoing = match result {
        Ok(result) => response(
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": envelope.request_id,
                "ok": true,
                "result": result,
            }),
            200,
        ),
        Err((code, message, retryable, status)) => {
            error_response(&envelope.request_id, &code, &message, retryable, status)
        }
    };
    let _ = request.respond(outgoing);
}

pub(crate) fn start(
    app: AppHandle,
    database: Arc<Mutex<Option<Connection>>>,
    database_error: Option<String>,
    pending: Arc<Mutex<Option<Value>>>,
) -> Result<IntegrationRuntime, String> {
    let directory = integration_directory()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let descriptor_path = directory.join("integration.json");
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let server = Server::from_listener(listener, None).map_err(|error| error.to_string())?;
    let token = format!(
        "{}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let instance_id = Uuid::new_v4().to_string();
    write_descriptor(&descriptor_path, port, &token, &instance_id)?;

    let cleanup_path = descriptor_path.clone();
    thread::Builder::new()
        .name("edi-local-integration".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                handle_request(
                    request,
                    &app,
                    &database,
                    &database_error,
                    &pending,
                    &token,
                    &instance_id,
                );
            }
            let _ = fs::remove_file(cleanup_path);
        })
        .map_err(|error| error.to_string())?;

    Ok(IntegrationRuntime { descriptor_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_requires_an_exact_match() {
        assert!(secure_equals("Bearer secret", "Bearer secret"));
        assert!(!secure_equals("Bearer secret", "Bearer other"));
        assert!(!secure_equals("short", "longer"));
    }

    #[test]
    fn resolves_an_exact_local_project_path() {
        let suffix = Uuid::new_v4();
        let root = std::env::temp_dir().join(format!("edi integration café-项目 {suffix}"));
        fs::create_dir_all(&root).unwrap();
        let db = Connection::open_in_memory().unwrap();
        for migration in [
            include_str!("../../packages/core/src/db/migrations/001_initial.sql"),
            include_str!("../../packages/core/src/db/migrations/002_git_state.sql"),
            include_str!("../../packages/core/src/db/migrations/003_git_status.sql"),
            include_str!("../../packages/core/src/db/migrations/004_project_memory.sql"),
        ] {
            db.execute_batch(migration).unwrap();
        }
        db.execute(
            "INSERT INTO projects(id,name,path) VALUES('project-1','Example',?1)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        let reference = ProjectRef {
            workspace_path: root.to_string_lossy().to_string(),
            repository_path: None,
            git_common_dir: None,
            remote_url: None,
            head_commit: None,
            branch: None,
        };

        let found = crate::resolve_integration_project(&db, &reference)
            .unwrap()
            .unwrap();
        assert_eq!(found["id"], "project-1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_entry_requests_create_one_record() {
        let db = Connection::open_in_memory().unwrap();
        for migration in [
            include_str!("../../packages/core/src/db/migrations/001_initial.sql"),
            include_str!("../../packages/core/src/db/migrations/002_git_state.sql"),
            include_str!("../../packages/core/src/db/migrations/003_git_status.sql"),
            include_str!("../../packages/core/src/db/migrations/004_project_memory.sql"),
            include_str!("../../packages/core/src/db/migrations/005_project_xray.sql"),
            include_str!("../../packages/core/src/db/migrations/006_engineering_memory.sql"),
            include_str!("../../packages/core/src/db/migrations/007_editor_integration.sql"),
        ] {
            db.execute_batch(migration).unwrap();
        }
        db.execute(
            "INSERT INTO projects(id,name,path) VALUES('project-1','Example','C:/example')",
            [],
        )
        .unwrap();
        let request: RequestEnvelope = serde_json::from_value(json!({
            "protocolVersion": 1,
            "requestId": "same-request",
            "action": "entry.create",
            "client": { "id": "edi-vscode", "version": "0.2.0" },
            "project": { "workspacePath": "C:/example" },
            "source": {
                "filePath": "C:/example/src/main.ts",
                "workspaceRelativePath": "src/main.ts",
                "languageId": "typescript",
                "selection": {
                    "text": "const answer = 42;",
                    "start": { "line": 3, "character": 0 },
                    "end": { "line": 3, "character": 18 }
                }
            },
            "payload": { "entryType": "note", "title": "Remember this", "comment": "Useful" }
        }))
        .unwrap();

        let first = create_integration_entry(&db, &request, "project-1").unwrap();
        let second = create_integration_entry(&db, &request, "project-1").unwrap();
        assert_eq!(first["created"], true);
        assert_eq!(second["created"], false);
        assert_eq!(second["duplicate"], true);
        assert_eq!(first["entryId"], second["entryId"]);
        let entries: i64 = db
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .unwrap();
        let sources: i64 = db
            .query_row("SELECT COUNT(*) FROM integration_sources", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(entries, 1);
        assert_eq!(sources, 1);
    }
}
