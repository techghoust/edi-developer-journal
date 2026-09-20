use chrono::{NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, process::Command, sync::Mutex};
use tauri::{Manager, State};
use uuid::Uuid;

mod xray;

struct AppState {
    db: Mutex<Option<Connection>>,
    db_error: Option<String>,
}

fn text(input: &Value, key: &str) -> String {
    input.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn optional_text(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

fn strings(input: &Value, key: &str) -> Vec<String> {
    input.get(key).and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string).collect()
}

fn with_db<T>(state: &State<AppState>, action: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let guard = state.db.lock().map_err(|_| "Database lock failed.".to_string())?;
    let db = guard.as_ref().ok_or_else(|| state.db_error.clone().unwrap_or_else(|| "Database unavailable.".into()))?;
    action(db)
}

fn execute(db: &Connection, sql: &str, values: &[&dyn rusqlite::ToSql]) -> Result<(), String> {
    db.execute(sql, values).map(|_| ()).map_err(|e| e.to_string())
}

fn normalized_name(value: &str) -> String {
    value.chars().filter(|character| character.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn relocation_search_root(old_path: &Path) -> Option<PathBuf> {
    if let Some(desktop) = dirs::desktop_dir() {
        if old_path.starts_with(&desktop) { return Some(desktop); }
    }
    old_path.ancestors().find(|candidate| candidate.is_dir() && candidate.parent().is_some()).map(Path::to_path_buf)
}

fn collect_git_repositories(root: &Path, depth: usize, scanned: &mut usize, repositories: &mut Vec<PathBuf>) {
    if depth == 0 || *scanned >= 6000 { return; }
    let Ok(entries) = fs::read_dir(root) else { return; };
    for entry in entries.flatten() {
        if *scanned >= 6000 { return; }
        let Ok(file_type) = entry.file_type() else { continue; };
        if !file_type.is_dir() { continue; }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if [".git", ".cache", ".codex", ".venv", "node_modules", "target", "target-current", "dist"].contains(&name.as_str()) { continue; }
        *scanned += 1;
        if path.join(".git").exists() { repositories.push(path.clone()); }
        collect_git_repositories(&path, depth - 1, scanned, repositories);
    }
}

fn repository_contains_commit(path: &Path, hash: &str) -> bool {
    let revision = format!("{hash}^{{commit}}");
    Command::new("git").args(["cat-file", "-e", &revision]).current_dir(path).output().map(|output| output.status.success()).unwrap_or(false)
}

fn find_relocated_project(old_path: &Path, project_name: &str, stored_head: &str, stored_remote: Option<&str>) -> Option<PathBuf> {
    if stored_head.is_empty() { return None; }
    let root = relocation_search_root(old_path)?;
    let mut repositories = Vec::new();
    let mut scanned = 0;
    collect_git_repositories(&root, 6, &mut scanned, &mut repositories);
    let old_name = normalized_name(old_path.file_name()?.to_str()?);
    let project_name = normalized_name(project_name);
    let mut candidates: Vec<(i32, PathBuf)> = repositories.into_iter().filter_map(|candidate| {
        if !repository_contains_commit(&candidate, stored_head) { return None; }
        let candidate_name = normalized_name(candidate.file_name()?.to_str()?);
        let parent_name = candidate.parent().and_then(Path::file_name).and_then(|value| value.to_str()).map(normalized_name).unwrap_or_default();
        let mut score = 0;
        if candidate_name == project_name { score += 6; }
        if candidate_name == old_name { score += 5; }
        if parent_name == old_name { score += 4; }
        if run_git(&candidate, &["rev-parse", "HEAD"]).as_deref() == Some(stored_head) { score += 4; }
        if let Some(remote) = stored_remote {
            if run_git(&candidate, &["remote", "get-url", "origin"]).as_deref() == Some(remote) { score += 8; }
        }
        Some((score, candidate))
    }).collect();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    let best = candidates.first()?;
    if candidates.get(1).is_some_and(|next| next.0 == best.0) { return None; }
    Some(best.1.clone())
}

fn project(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    db.query_row("SELECT id,name,path,git_remote,created_at,last_checked_at,last_head_hash,last_working_tree_clean,git_status,last_changed_files,last_untracked_files FROM projects WHERE id=?1", [id], |r| {
        let path = r.get::<_, String>(2)?;
        let path_exists = Path::new(&path).is_dir();
        Ok(json!({
        "id":r.get::<_,String>(0)?, "name":r.get::<_,String>(1)?, "path":path, "pathExists":path_exists, "gitRemote":r.get::<_,Option<String>>(3)?, "createdAt":r.get::<_,String>(4)?,
        "lastCheckedAt":r.get::<_,Option<String>>(5)?, "lastHeadHash":r.get::<_,Option<String>>(6)?, "lastWorkingTreeClean":r.get::<_,i64>(7)? == 1,
        "gitStatus":r.get::<_,String>(8)?, "lastChangedFiles":r.get::<_,i64>(9)?, "lastUntrackedFiles":r.get::<_,i64>(10)?
    }))}).optional().map_err(|e| e.to_string())
}

fn entry(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    let mut value = db.query_row("SELECT id,project_id,title,body_md,source,created_at,updated_at FROM entries WHERE id=?1", [id], |r| Ok(json!({
        "id":r.get::<_,String>(0)?, "projectId":r.get::<_,String>(1)?, "title":r.get::<_,String>(2)?, "bodyMd":r.get::<_,String>(3)?,
        "source":r.get::<_,String>(4)?, "createdAt":r.get::<_,String>(5)?, "updatedAt":r.get::<_,String>(6)?
    }))).optional().map_err(|e| e.to_string())?;
    if let Some(ref mut item) = value {
        item["tags"] = json!(query_strings(db, "SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id=t.id WHERE et.entry_id=?1 ORDER BY t.name", id)?);
        item["commitHashes"] = json!(query_strings(db, "SELECT commit_hash FROM entry_commits WHERE entry_id=?1", id)?);
    }
    Ok(value)
}

fn checkpoint(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    let mut value = db.query_row("SELECT id,project_id,title,note,working_on,current_works,broken_or_unfinished,trying_to_understand,decisions_made,alternatives_rejected,open_questions,next_step,created_at FROM checkpoints WHERE id=?1", [id], |r| Ok(json!({
        "id":r.get::<_,String>(0)?, "projectId":r.get::<_,String>(1)?, "title":r.get::<_,String>(2)?, "note":r.get::<_,String>(3)?,
        "workingOn":r.get::<_,String>(4)?, "currentWorks":r.get::<_,String>(5)?, "brokenOrUnfinished":r.get::<_,String>(6)?, "tryingToUnderstand":r.get::<_,String>(7)?,
        "decisionsMade":r.get::<_,String>(8)?, "alternativesRejected":r.get::<_,String>(9)?, "openQuestions":r.get::<_,String>(10)?, "nextStep":r.get::<_,String>(11)?, "createdAt":r.get::<_,String>(12)?
    }))).optional().map_err(|e| e.to_string())?;
    if let Some(ref mut item) = value { add_relations(db, item, "checkpoint", id)?; }
    Ok(value)
}

fn decision(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    let mut value = db.query_row("SELECT id,project_id,title,status,reason,notes,parent_decision_id,replacement_decision_id,checkpoint_id,temporary,revisit_condition,revisit_date,review_status,created_at,updated_at FROM decisions WHERE id=?1", [id], |r| Ok(json!({
        "id":r.get::<_,String>(0)?, "projectId":r.get::<_,String>(1)?, "title":r.get::<_,String>(2)?, "status":r.get::<_,String>(3)?, "reason":r.get::<_,String>(4)?, "notes":r.get::<_,String>(5)?,
        "parentDecisionId":r.get::<_,Option<String>>(6)?, "replacementDecisionId":r.get::<_,Option<String>>(7)?, "checkpointId":r.get::<_,Option<String>>(8)?,
        "temporary":r.get::<_,i64>(9)? == 1, "revisitCondition":r.get::<_,String>(10)?, "revisitDate":r.get::<_,Option<String>>(11)?, "reviewStatus":r.get::<_,String>(12)?,
        "createdAt":r.get::<_,String>(13)?, "updatedAt":r.get::<_,String>(14)?
    }))).optional().map_err(|e| e.to_string())?;
    if let Some(ref mut item) = value {
        add_relations(db, item, "decision", id)?;
        item["assumptionIds"] = json!(query_strings(db, "SELECT assumption_id FROM decision_assumptions WHERE decision_id=?1 ORDER BY assumption_id", id)?);
    }
    Ok(value)
}

fn research(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    let mut value = db.query_row("SELECT id,project_id,type,title,path_or_url,notes,created_at FROM research_items WHERE id=?1", [id], |r| Ok(json!({
        "id":r.get::<_,String>(0)?, "projectId":r.get::<_,String>(1)?, "type":r.get::<_,String>(2)?, "title":r.get::<_,String>(3)?,
        "pathOrUrl":r.get::<_,Option<String>>(4)?, "notes":r.get::<_,String>(5)?, "createdAt":r.get::<_,String>(6)?
    }))).optional().map_err(|e| e.to_string())?;
    if let Some(ref mut item) = value { item["entryIds"] = json!(query_strings(db, "SELECT entry_id FROM research_links WHERE research_id=?1 ORDER BY entry_id", id)?); }
    Ok(value)
}

fn assumption(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    db.query_row("SELECT id,project_id,statement,status,notes,created_at,invalidated_at FROM assumptions WHERE id=?1", [id], |row| Ok(json!({
        "id":row.get::<_,String>(0)?, "projectId":row.get::<_,String>(1)?, "statement":row.get::<_,String>(2)?,
        "status":row.get::<_,String>(3)?, "notes":row.get::<_,String>(4)?, "createdAt":row.get::<_,String>(5)?,
        "invalidatedAt":row.get::<_,Option<String>>(6)?,
    }))).optional().map_err(|error| error.to_string())
}

fn experiment(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    let mut value = db.query_row("SELECT id,project_id,title,hypothesis,tested,method,result,conclusion,status,experiment_date,resulting_decision_id,notes,created_at,updated_at FROM experiments WHERE id=?1", [id], |row| Ok(json!({
        "id":row.get::<_,String>(0)?, "projectId":row.get::<_,String>(1)?, "title":row.get::<_,String>(2)?,
        "hypothesis":row.get::<_,String>(3)?, "tested":row.get::<_,String>(4)?, "method":row.get::<_,String>(5)?,
        "result":row.get::<_,String>(6)?, "conclusion":row.get::<_,String>(7)?, "status":row.get::<_,String>(8)?,
        "experimentDate":row.get::<_,String>(9)?, "resultingDecisionId":row.get::<_,Option<String>>(10)?,
        "notes":row.get::<_,String>(11)?, "createdAt":row.get::<_,String>(12)?, "updatedAt":row.get::<_,String>(13)?,
    }))).optional().map_err(|error| error.to_string())?;
    if let Some(ref mut item) = value {
        add_relations(db, item, "experiment", id)?;
        item["assumptionIds"] = json!(query_strings(db, "SELECT assumption_id FROM experiment_assumptions WHERE experiment_id=?1 ORDER BY assumption_id", id)?);
    }
    Ok(value)
}

fn query_strings(db: &Connection, sql: &str, id: &str) -> Result<Vec<String>, String> {
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement.query_map([id], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<String>, _>>().map_err(|e| e.to_string())
}

fn xray_memory_links(db: &Connection, project_id: &str, dependency_name: &str) -> Result<Vec<Value>, String> {
    let mut statement = db.prepare(
        "SELECT l.memory_kind,l.memory_id,COALESCE(t.title,'missing memory item') \
         FROM xray_memory_links l LEFT JOIN project_memory_timeline t \
         ON t.project_id=l.project_id AND t.kind=l.memory_kind AND t.id=l.memory_id \
         WHERE l.project_id=?1 AND l.dependency_name=?2 ORDER BY l.memory_kind,t.occurred_at DESC"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![project_id, dependency_name], |row| Ok(json!({
        "kind": row.get::<_, String>(0)?,
        "id": row.get::<_, String>(1)?,
        "title": row.get::<_, String>(2)?,
    }))).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

fn add_relations(db: &Connection, item: &mut Value, prefix: &str, id: &str) -> Result<(), String> {
    item["commitHashes"] = json!(query_strings(db, &format!("SELECT commit_hash FROM {prefix}_commits WHERE {prefix}_id=?1 ORDER BY commit_hash"), id)?);
    item["filePaths"] = json!(query_strings(db, &format!("SELECT file_path FROM {prefix}_files WHERE {prefix}_id=?1 ORDER BY file_path"), id)?);
    item["entryIds"] = json!(query_strings(db, &format!("SELECT entry_id FROM {prefix}_entries WHERE {prefix}_id=?1 ORDER BY entry_id"), id)?);
    item["researchIds"] = json!(query_strings(db, &format!("SELECT research_id FROM {prefix}_research WHERE {prefix}_id=?1 ORDER BY research_id"), id)?);
    Ok(())
}

fn set_entry_relations(db: &Connection, id: &str, project_id: &str, input: &Value) -> Result<(), String> {
    execute(db, "DELETE FROM entry_tags WHERE entry_id=?1", &[&id])?;
    for tag in strings(input, "tags") {
        let tag = tag.to_lowercase(); let tag_id = Uuid::new_v4().to_string();
        execute(db, "INSERT OR IGNORE INTO tags(id,name) VALUES(?1,?2)", &[&tag_id, &tag])?;
        execute(db, "INSERT OR IGNORE INTO entry_tags(entry_id,tag_id) SELECT ?1,id FROM tags WHERE name=?2", &[&id, &tag])?;
    }
    execute(db, "DELETE FROM entry_commits WHERE entry_id=?1", &[&id])?;
    for hash in strings(input, "commitHashes") { execute(db, "INSERT OR IGNORE INTO entry_commits(entry_id,commit_hash,project_id) VALUES(?1,?2,?3)", &[&id,&hash,&project_id])?; }
    Ok(())
}

fn set_memory_relations(db: &Connection, prefix: &str, id: &str, project_id: &str, input: &Value) -> Result<(), String> {
    for (key, suffix, column) in [("commitHashes","commits","commit_hash"),("filePaths","files","file_path"),("entryIds","entries","entry_id"),("researchIds","research","research_id")] {
        if input.get(key).is_none() { continue; }
        execute(db, &format!("DELETE FROM {prefix}_{suffix} WHERE {prefix}_id=?1"), &[&id])?;
        for value in strings(input, key) {
            if suffix == "commits" { execute(db, &format!("INSERT OR IGNORE INTO {prefix}_{suffix}({prefix}_id,{column},project_id) VALUES(?1,?2,?3)"), &[&id,&value,&project_id])?; }
            else { execute(db, &format!("INSERT OR IGNORE INTO {prefix}_{suffix}({prefix}_id,{column}) VALUES(?1,?2)"), &[&id,&value])?; }
        }
    }
    Ok(())
}

fn set_assumption_relations(db: &Connection, prefix: &str, id: &str, input: &Value) -> Result<(), String> {
    if input.get("assumptionIds").is_none() { return Ok(()); }
    execute(db, &format!("DELETE FROM {prefix}_assumptions WHERE {prefix}_id=?1"), &[&id])?;
    for assumption_id in strings(input, "assumptionIds") {
        execute(db, &format!("INSERT OR IGNORE INTO {prefix}_assumptions({prefix}_id,assumption_id) VALUES(?1,?2)"), &[&id, &assumption_id])?;
    }
    Ok(())
}

#[tauri::command] fn get_app_status(state: State<AppState>) -> Value { json!({"dbReady":state.db.lock().map(|v|v.is_some()).unwrap_or(false),"dbError":state.db_error}) }

#[tauri::command] fn list_projects(state: State<AppState>) -> Result<Vec<Value>,String> { with_db(&state, |db| {
    let mut statement=db.prepare("SELECT id FROM projects ORDER BY created_at DESC,rowid DESC").map_err(|e|e.to_string())?;
    let rows=statement.query_map([],|r|r.get(0)).map_err(|e|e.to_string())?;
    let ids=rows.collect::<Result<Vec<String>,_>>().map_err(|e|e.to_string())?;
    ids.iter().map(|id| project(db,id).map(|v|v.unwrap())).collect()
}) }

#[tauri::command] fn auto_relocate_projects(state:State<AppState>)->Result<Vec<Value>,String>{with_db(&state,|db|{
    let mut statement=db.prepare("SELECT id,name,path,last_head_hash,git_remote FROM projects ORDER BY created_at DESC,rowid DESC").map_err(|e|e.to_string())?;
    let rows=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?))).map_err(|e|e.to_string())?;
    let saved=rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let mut relocated=Vec::new();
    for (id,name,old_path,head,remote) in saved {
        if Path::new(&old_path).is_dir() { continue; }
        let Some(head)=head.filter(|value|!value.is_empty()) else { continue; };
        let Some(found)=find_relocated_project(Path::new(&old_path),&name,&head,remote.as_deref()) else { continue; };
        let path=found.to_string_lossy().to_string();
        let owner:Option<String>=db.query_row("SELECT id FROM projects WHERE path=?1 AND id<>?2",params![path,id],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
        if owner.is_some() { continue; }
        execute(db,"UPDATE projects SET path=?1 WHERE id=?2",&[&path,&id])?;
        refresh_git(db,&id,&found)?;
        if let Some(item)=project(db,&id)? { relocated.push(item); }
    }
    Ok(relocated)
})}

#[tauri::command] fn get_project(state: State<AppState>, project_id:String) -> Result<Option<Value>,String> { with_db(&state,|db|project(db,&project_id)) }

#[tauri::command]
fn update_project_name(state: State<AppState>, input: Value) -> Result<Value, String> {
    let project_id = text(&input, "projectId");
    let name = text(&input, "name");
    if name.is_empty() { return Err("Project name is required.".into()); }
    with_db(&state, |db| {
        execute(db, "UPDATE projects SET name=?1 WHERE id=?2", &[&name, &project_id])?;
        project(db, &project_id)?.ok_or("Project not found.".into())
    })
}

#[tauri::command] fn delete_project(state:State<AppState>,project_id:String)->Result<(),String>{with_db(&state,|db|execute(db,"DELETE FROM projects WHERE id=?1",&[&project_id]))}

fn validate_path(path:&str, allow_non_git:bool)->Result<PathBuf,String>{ let p=PathBuf::from(path.trim()); if !p.is_dir(){return Err("Project folder does not exist or cannot be accessed.".into())} let status=git_status(&p); if !allow_non_git && status["state"]!="ok"{return Err("Selected folder is not a Git repository. Enable allow folder without Git to add it anyway.".into())} Ok(p) }

#[tauri::command] fn choose_project_path()->Option<String>{ rfd::FileDialog::new().set_title("Select project folder").pick_folder().map(|p|p.to_string_lossy().into_owned()) }

#[tauri::command]
fn choose_media_file(media_type: String) -> Option<String> {
    let dialog = rfd::FileDialog::new().set_title("Select media file");
    let dialog = match media_type.as_str() {
        "image" => dialog.add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]),
        "video" => dialog.add_filter("Videos", &["mp4", "webm", "mov", "mkv", "avi"]),
        "pdf" => dialog.add_filter("PDF", &["pdf"]),
        _ => dialog.add_filter("Media", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "mp4", "webm", "mov", "mkv", "avi", "pdf"]),
    };
    dialog.pick_file().map(|path| path.to_string_lossy().into_owned())
}

fn attachments_root() -> Result<PathBuf, String> {
    let config = dirs::config_dir().ok_or("Cannot resolve application data directory.")?;
    Ok(config.join("EDI Developer Journal").join("attachments"))
}

fn persist_media_file_in(root: &Path, project_id: &str, location: &str) -> Result<String, String> {
    let source = Path::new(location.trim());
    if !source.is_file() { return Ok(location.trim().to_string()); }
    let source = source.canonicalize().map_err(|error| format!("Cannot read media file: {error}"))?;
    let root = root.to_path_buf();
    if source.starts_with(&root) { return Ok(source.to_string_lossy().into_owned()); }

    let project_folder = root.join(project_id);
    fs::create_dir_all(&project_folder).map_err(|error| format!("Cannot create attachment storage: {error}"))?;
    let original_name = source.file_name().and_then(|value| value.to_str()).unwrap_or("attachment");
    let destination = project_folder.join(format!("{}-{original_name}", Uuid::new_v4()));
    fs::copy(&source, &destination).map_err(|error| format!("Cannot save media inside the journal: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

fn persist_media_location(project_id: &str, location: Option<String>) -> Result<Option<String>, String> {
    location.map(|value| {
        if value.starts_with("https://") || value.starts_with("http://") || value.starts_with("data:") || value.starts_with("blob:") {
            Ok(value)
        } else {
            persist_media_file_in(&attachments_root()?, project_id, &value)
        }
    }).transpose()
}

fn remove_managed_media_file(location: &str) {
    let Ok(root) = attachments_root() else { return; };
    let path = Path::new(location);
    if path.starts_with(root) && path.is_file() { let _ = fs::remove_file(path); }
}

fn migrate_research_attachments(db: &Connection) {
    let Ok(mut statement) = db.prepare("SELECT id,project_id,path_or_url FROM research_items WHERE path_or_url IS NOT NULL") else { return; };
    let Ok(rows) = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))) else { return; };
    let items: Vec<_> = rows.filter_map(Result::ok).collect();
    drop(statement);

    for (id, project_id, location) in items {
        let Ok(Some(stored)) = persist_media_location(&project_id, Some(location.clone())) else { continue; };
        if stored == location { continue; }
        let _ = db.execute("UPDATE research_items SET path_or_url=?1 WHERE id=?2", params![stored, id]);
    }
}

#[tauri::command]
fn open_media_location(location: String) -> Result<(), String> {
    let target = location.trim();
    if target.is_empty() { return Err("Media location is empty.".into()); }
    let is_web = target.starts_with("https://") || target.starts_with("http://");
    if !is_web && !Path::new(target).exists() { return Err("Media file does not exist or cannot be accessed.".into()); }
    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(target).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(target).spawn();
    result.map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_data_directory() -> Result<String, String> {
    let path = dirs::config_dir().ok_or("Cannot resolve application data directory.")?.join("EDI Developer Journal");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn export_project_data(state: State<AppState>, project_id: String) -> Result<Option<String>, String> {
    let export = with_db(&state, |db| {
        let project_value = project(db, &project_id)?.ok_or("Project not found.")?;
        let collect = |sql: &str, read: fn(&Connection, &str) -> Result<Option<Value>, String>| -> Result<Vec<Value>, String> {
            let ids = query_ids(db, sql, &project_id)?;
            ids.iter().map(|id| read(db, id).map(|value| value.unwrap())).collect()
        };
        let entries = collect("SELECT id FROM entries WHERE project_id=?1 ORDER BY created_at", entry)?;
        let checkpoints = collect("SELECT id FROM checkpoints WHERE project_id=?1 ORDER BY created_at", checkpoint)?;
        let decisions = collect("SELECT id FROM decisions WHERE project_id=?1 ORDER BY created_at,rowid", decision)?;
        let research_items = collect("SELECT id FROM research_items WHERE project_id=?1 ORDER BY created_at,rowid", research)?;
        let experiments = collect("SELECT id FROM experiments WHERE project_id=?1 ORDER BY experiment_date,created_at,rowid", experiment)?;
        let assumptions = collect("SELECT id FROM assumptions WHERE project_id=?1 ORDER BY created_at,rowid", assumption)?;
        let mut xray_statement = db.prepare("SELECT dependency_name,memory_kind,memory_id,created_at FROM xray_memory_links WHERE project_id=?1 ORDER BY dependency_name,memory_kind,memory_id").map_err(|error| error.to_string())?;
        let xray_rows = xray_statement.query_map([&project_id], |row| Ok(json!({
            "dependencyName":row.get::<_,String>(0)?, "memoryKind":row.get::<_,String>(1)?,
            "memoryId":row.get::<_,String>(2)?, "createdAt":row.get::<_,String>(3)?,
        }))).map_err(|error| error.to_string())?;
        let xray_links = xray_rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        Ok(json!({
            "format":"edi-developer-journal", "schemaVersion":1, "exportedAt":Utc::now().to_rfc3339(),
            "project":project_value, "notes":entries, "checkpoints":checkpoints, "decisions":decisions,
            "research":research_items, "experiments":experiments, "assumptions":assumptions,
            "xrayMemoryLinks":xray_links,
        }))
    })?;
    let project_name = export["project"]["name"].as_str().unwrap_or("project");
    let suggested = format!("{}-edi-memory.json", normalized_name(project_name));
    let Some(path) = rfd::FileDialog::new().set_title("Export project data").add_filter("JSON", &["json"]).set_file_name(&suggested).save_file() else { return Ok(None); };
    let data = serde_json::to_string_pretty(&export).map_err(|error| error.to_string())?;
    fs::write(&path, data).map_err(|error| format!("Failed to export project data: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn import_rows<'a>(export: &'a Value, key: &str) -> &'a [Value] {
    export.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn imported_time(item: &Value, key: &str) -> String {
    optional_text(item, key).unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn belongs_to_project(db: &Connection, table: &str, id: &str, project_id: &str) -> Result<bool, String> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE id=?1 AND project_id=?2");
    db.query_row(&sql, params![id, project_id], |row| row.get::<_, i64>(0))
        .map(|count| count > 0).map_err(|error| error.to_string())
}

fn import_project_memory(db: &Connection, project_id: &str, export: &Value) -> Result<usize, String> {
    let exists: i64 = db.query_row("SELECT COUNT(*) FROM projects WHERE id=?1", [project_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if exists == 0 { return Err("Project not found.".into()); }
    if export.get("format").and_then(Value::as_str) != Some("edi-developer-journal") {
        return Err("This is not an EDI Developer Journal export.".into());
    }
    if export.get("schemaVersion").and_then(Value::as_i64).unwrap_or_default() != 1 {
        return Err("This export version is not supported.".into());
    }

    let transaction = db.unchecked_transaction().map_err(|error| error.to_string())?;
    let mut imported = 0usize;

    for item in import_rows(export, "notes") {
        let id = text(item, "id");
        if id.is_empty() { continue; }
        let source = match text(item, "source").as_str() { "auto" => "auto", _ => "manual" };
        imported += transaction.execute(
            "INSERT OR IGNORE INTO entries(id,project_id,title,body_md,source,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, project_id, text(item,"title"), text(item,"bodyMd"), source, imported_time(item,"createdAt"), imported_time(item,"updatedAt")],
        ).map_err(|error| error.to_string())?;
    }
    for item in import_rows(export, "research") {
        let id = text(item, "id");
        if id.is_empty() { continue; }
        let kind = match text(item, "type").as_str() { "pdf"=>"pdf", "link"=>"link", "image"=>"image", "video"=>"video", _=>"note" };
        imported += transaction.execute(
            "INSERT OR IGNORE INTO research_items(id,project_id,type,title,path_or_url,notes,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, project_id, kind, text(item,"title"), optional_text(item,"pathOrUrl"), text(item,"notes"), imported_time(item,"createdAt")],
        ).map_err(|error| error.to_string())?;
    }
    for item in import_rows(export, "assumptions") {
        let id = text(item, "id");
        if id.is_empty() { continue; }
        let status = match text(item, "status").as_str() { "questioned"=>"questioned", "invalidated"=>"invalidated", _=>"active" };
        imported += transaction.execute(
            "INSERT OR IGNORE INTO assumptions(id,project_id,statement,status,notes,created_at,invalidated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, project_id, text(item,"statement"), status, text(item,"notes"), imported_time(item,"createdAt"), optional_text(item,"invalidatedAt")],
        ).map_err(|error| error.to_string())?;
    }
    for item in import_rows(export, "checkpoints") {
        let id = text(item, "id");
        if id.is_empty() { continue; }
        imported += transaction.execute(
            "INSERT OR IGNORE INTO checkpoints(id,project_id,title,note,working_on,current_works,broken_or_unfinished,trying_to_understand,decisions_made,alternatives_rejected,open_questions,next_step,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![id,project_id,text(item,"title"),text(item,"note"),text(item,"workingOn"),text(item,"currentWorks"),text(item,"brokenOrUnfinished"),text(item,"tryingToUnderstand"),text(item,"decisionsMade"),text(item,"alternativesRejected"),text(item,"openQuestions"),text(item,"nextStep"),imported_time(item,"createdAt")],
        ).map_err(|error| error.to_string())?;
    }
    let mut new_decisions = Vec::new();
    for item in import_rows(export, "decisions") {
        let id = text(item, "id");
        if id.is_empty() { continue; }
        let status = match text(item,"status").as_str() { "superseded"=>"superseded", "rejected"=>"rejected", "experimental"=>"experimental", _=>"active" };
        let review = match text(item,"reviewStatus").as_str() { "reviewed"=>"reviewed", "dismissed"=>"dismissed", _=>"pending" };
        let added = transaction.execute(
            "INSERT OR IGNORE INTO decisions(id,project_id,title,status,reason,notes,temporary,revisit_condition,revisit_date,review_status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id,project_id,text(item,"title"),status,text(item,"reason"),text(item,"notes"),item.get("temporary").and_then(Value::as_bool).unwrap_or(false),text(item,"revisitCondition"),optional_text(item,"revisitDate"),review,imported_time(item,"createdAt"),imported_time(item,"updatedAt")],
        ).map_err(|error| error.to_string())?;
        if added > 0 { new_decisions.push(id); imported += added; }
    }
    for item in import_rows(export, "decisions") {
        let id = text(item,"id");
        if !new_decisions.contains(&id) { continue; }
        for (column, key) in [("parent_decision_id","parentDecisionId"),("replacement_decision_id","replacementDecisionId"),("checkpoint_id","checkpointId")] {
            let Some(target) = optional_text(item,key) else { continue; };
            let table = if key == "checkpointId" { "checkpoints" } else { "decisions" };
            if belongs_to_project(&transaction,table,&target,project_id)? {
                transaction.execute(&format!("UPDATE decisions SET {column}=?1 WHERE id=?2"), params![target,id]).map_err(|error| error.to_string())?;
            }
        }
    }
    for item in import_rows(export, "experiments") {
        let id = text(item,"id");
        if id.is_empty() { continue; }
        let status = match text(item,"status").as_str() { "running"=>"running", "successful"=>"successful", "failed"=>"failed", "inconclusive"=>"inconclusive", "abandoned"=>"abandoned", _=>"planned" };
        let decision_id = optional_text(item,"resultingDecisionId").filter(|value| belongs_to_project(&transaction,"decisions",value,project_id).unwrap_or(false));
        imported += transaction.execute(
            "INSERT OR IGNORE INTO experiments(id,project_id,title,hypothesis,tested,method,result,conclusion,status,experiment_date,resulting_decision_id,notes,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![id,project_id,text(item,"title"),text(item,"hypothesis"),text(item,"tested"),text(item,"method"),text(item,"result"),text(item,"conclusion"),status,text(item,"experimentDate"),decision_id,text(item,"notes"),imported_time(item,"createdAt"),imported_time(item,"updatedAt")],
        ).map_err(|error| error.to_string())?;
    }

    for item in import_rows(export,"notes") {
        let id=text(item,"id"); if !belongs_to_project(&transaction,"entries",&id,project_id)? { continue; }
        for tag in strings(item,"tags") {
            transaction.execute("INSERT OR IGNORE INTO tags(id,name) VALUES(?1,?2)",params![Uuid::new_v4().to_string(),tag.to_lowercase()]).map_err(|error| error.to_string())?;
            transaction.execute("INSERT OR IGNORE INTO entry_tags(entry_id,tag_id) SELECT ?1,id FROM tags WHERE name=?2",params![id,tag.to_lowercase()]).map_err(|error| error.to_string())?;
        }
        for hash in strings(item,"commitHashes") { transaction.execute("INSERT OR IGNORE INTO entry_commits(entry_id,commit_hash,project_id) VALUES(?1,?2,?3)",params![id,hash,project_id]).map_err(|error| error.to_string())?; }
    }
    for item in import_rows(export,"research") {
        let id=text(item,"id"); if !belongs_to_project(&transaction,"research_items",&id,project_id)? { continue; }
        for entry_id in strings(item,"entryIds") { if belongs_to_project(&transaction,"entries",&entry_id,project_id)? { transaction.execute("INSERT OR IGNORE INTO research_links(research_id,entry_id) VALUES(?1,?2)",params![id,entry_id]).map_err(|error| error.to_string())?; } }
    }
    for (key,prefix,table) in [("checkpoints","checkpoint","checkpoints"),("decisions","decision","decisions"),("experiments","experiment","experiments")] {
        for item in import_rows(export,key) {
            let id=text(item,"id"); if !belongs_to_project(&transaction,table,&id,project_id)? { continue; }
            for hash in strings(item,"commitHashes") { transaction.execute(&format!("INSERT OR IGNORE INTO {prefix}_commits({prefix}_id,commit_hash,project_id) VALUES(?1,?2,?3)"),params![id,hash,project_id]).map_err(|error| error.to_string())?; }
            for path in strings(item,"filePaths") { transaction.execute(&format!("INSERT OR IGNORE INTO {prefix}_files({prefix}_id,file_path) VALUES(?1,?2)"),params![id,path]).map_err(|error| error.to_string())?; }
            for entry_id in strings(item,"entryIds") { if belongs_to_project(&transaction,"entries",&entry_id,project_id)? { transaction.execute(&format!("INSERT OR IGNORE INTO {prefix}_entries({prefix}_id,entry_id) VALUES(?1,?2)"),params![id,entry_id]).map_err(|error| error.to_string())?; } }
            for research_id in strings(item,"researchIds") { if belongs_to_project(&transaction,"research_items",&research_id,project_id)? { transaction.execute(&format!("INSERT OR IGNORE INTO {prefix}_research({prefix}_id,research_id) VALUES(?1,?2)"),params![id,research_id]).map_err(|error| error.to_string())?; } }
            if prefix != "checkpoint" { for assumption_id in strings(item,"assumptionIds") { if belongs_to_project(&transaction,"assumptions",&assumption_id,project_id)? { transaction.execute(&format!("INSERT OR IGNORE INTO {prefix}_assumptions({prefix}_id,assumption_id) VALUES(?1,?2)"),params![id,assumption_id]).map_err(|error| error.to_string())?; } } }
        }
    }
    for link in import_rows(export,"xrayMemoryLinks") {
        let kind=text(link,"memoryKind"); let memory_id=text(link,"memoryId"); let dependency=text(link,"dependencyName");
        let table=match kind.as_str(){"journal"=>"entries","checkpoint"=>"checkpoints","decision"=>"decisions","research"=>"research_items","experiment"=>"experiments","assumption"=>"assumptions",_=>continue};
        if !dependency.is_empty() && belongs_to_project(&transaction,table,&memory_id,project_id)? { transaction.execute("INSERT OR IGNORE INTO xray_memory_links(project_id,dependency_name,memory_kind,memory_id) VALUES(?1,?2,?3,?4)",params![project_id,dependency,kind,memory_id]).map_err(|error| error.to_string())?; }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(imported)
}

#[tauri::command]
fn import_project_data(state: State<AppState>, project_id: String) -> Result<Option<Value>, String> {
    let Some(path) = rfd::FileDialog::new().set_title("Import project data").add_filter("JSON", &["json"]).pick_file() else { return Ok(None); };
    let raw = fs::read_to_string(&path).map_err(|error| format!("Failed to read import file: {error}"))?;
    let export: Value = serde_json::from_str(&raw).map_err(|error| format!("Invalid JSON: {error}"))?;
    let imported = with_db(&state, |db| import_project_memory(db, &project_id, &export))?;
    Ok(Some(json!({"path":path.to_string_lossy(),"imported":imported})))
}

#[tauri::command] fn create_project(state:State<AppState>,input:Value)->Result<Value,String>{ let p=validate_path(&text(&input,"path"),input.get("allowNonGit").and_then(Value::as_bool).unwrap_or(false))?; with_db(&state,|db|{
    let id=Uuid::new_v4().to_string(); execute(db,"INSERT INTO projects(id,name,path,git_remote) VALUES(?1,?2,?3,NULL)",&[&id,&text(&input,"name"),&p.to_string_lossy().to_string()])?; refresh_git(db,&id,&p)?; project(db,&id)?.ok_or("Failed to create project.".into())
}) }

#[tauri::command] fn open_project_path(state:State<AppState>,input:Value)->Result<Value,String>{ let p=validate_path(&text(&input,"path"),input.get("allowNonGit").and_then(Value::as_bool).unwrap_or(false))?; let path=p.to_string_lossy().to_string(); with_db(&state,|db|{
    let found:Option<String>=db.query_row("SELECT id FROM projects WHERE path=?1",[&path],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let id=found.unwrap_or_else(||Uuid::new_v4().to_string()); if project(db,&id)?.is_none(){let name=p.file_name().and_then(|v|v.to_str()).unwrap_or(&path);execute(db,"INSERT INTO projects(id,name,path) VALUES(?1,?2,?3)",&[&id,&name,&path])?;refresh_git(db,&id,&p)?;} project(db,&id)?.ok_or("Project not found.".into())
}) }

#[tauri::command] fn relocate_project(state:State<AppState>,input:Value)->Result<Value,String>{ let p=validate_path(&text(&input,"path"),true)?; let path=p.to_string_lossy().to_string(); let id=text(&input,"projectId"); with_db(&state,|db|{
    if project(db,&id)?.is_none(){return Err("Project not found.".into())}
    let owner:Option<String>=db.query_row("SELECT id FROM projects WHERE path=?1 AND id<>?2",params![path,id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if owner.is_some(){return Err("That folder already belongs to another project.".into())}
    execute(db,"UPDATE projects SET path=?1 WHERE id=?2",&[&path,&id])?;
    refresh_git(db,&id,&p)?;
    project(db,&id)?.ok_or("Project not found.".into())
}) }

#[tauri::command] fn list_entries(state:State<AppState>,project_id:String)->Result<Vec<Value>,String>{with_db(&state,|db|{let ids=query_ids(db,"SELECT id FROM entries WHERE project_id=?1 ORDER BY created_at DESC",&project_id)?;ids.iter().map(|id|entry(db,id).map(|v|v.unwrap())).collect()})}
#[tauri::command] fn create_entry(state:State<AppState>,input:Value)->Result<Value,String>{with_db(&state,|db|{let id=Uuid::new_v4().to_string();let pid=text(&input,"projectId");execute(db,"INSERT INTO entries(id,project_id,title,body_md,source) VALUES(?1,?2,?3,?4,'manual')",&[&id,&pid,&text(&input,"title"),&text(&input,"bodyMd")])?;set_entry_relations(db,&id,&pid,&input)?;entry(db,&id)?.ok_or("Entry not found.".into())})}
#[tauri::command] fn update_entry(state:State<AppState>,input:Value)->Result<Value,String>{with_db(&state,|db|{let id=text(&input,"id");let old=entry(db,&id)?.ok_or("Entry not found.")?;let pid=old["projectId"].as_str().unwrap();execute(db,"UPDATE entries SET title=?1,body_md=?2,updated_at=datetime('now') WHERE id=?3",&[&text(&input,"title"),&text(&input,"bodyMd"),&id])?;set_entry_relations(db,&id,pid,&input)?;entry(db,&id)?.ok_or("Entry not found.".into())})}
#[tauri::command] fn delete_entry(state:State<AppState>,entry_id:String)->Result<(),String>{with_db(&state,|db|execute(db,"DELETE FROM entries WHERE id=?1",&[&entry_id]))}

#[tauri::command] fn list_checkpoints(state:State<AppState>,project_id:String)->Result<Vec<Value>,String>{with_db(&state,|db|{let ids=query_ids(db,"SELECT id FROM checkpoints WHERE project_id=?1 ORDER BY created_at DESC,rowid DESC",&project_id)?;ids.iter().map(|id|checkpoint(db,id).map(|v|v.unwrap())).collect()})}
#[tauri::command] fn create_checkpoint(state:State<AppState>,input:Value)->Result<Value,String>{with_db(&state,|db|{let id=Uuid::new_v4().to_string();let pid=text(&input,"projectId");execute(db,"INSERT INTO checkpoints(id,project_id,title,note,working_on,current_works,broken_or_unfinished,trying_to_understand,decisions_made,alternatives_rejected,open_questions,next_step) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",&[&id,&pid,&text(&input,"title"),&text(&input,"note"),&text(&input,"workingOn"),&text(&input,"currentWorks"),&text(&input,"brokenOrUnfinished"),&text(&input,"tryingToUnderstand"),&text(&input,"decisionsMade"),&text(&input,"alternativesRejected"),&text(&input,"openQuestions"),&text(&input,"nextStep")])?;set_memory_relations(db,"checkpoint",&id,&pid,&input)?;checkpoint(db,&id)?.ok_or("Checkpoint not found.".into())})}
#[tauri::command] fn delete_checkpoint(state:State<AppState>,checkpoint_id:String)->Result<(),String>{with_db(&state,|db|execute(db,"DELETE FROM checkpoints WHERE id=?1",&[&checkpoint_id]))}

#[tauri::command] fn list_decisions(state:State<AppState>,project_id:String)->Result<Vec<Value>,String>{with_db(&state,|db|{let ids=query_ids(db,"SELECT id FROM decisions WHERE project_id=?1 ORDER BY created_at ASC,rowid ASC",&project_id)?;ids.iter().map(|id|decision(db,id).map(|v|v.unwrap())).collect()})}
#[tauri::command]
fn create_decision(state: State<AppState>, input: Value) -> Result<Value, String> {
    with_db(&state, |db| {
        let id = Uuid::new_v4().to_string();
        let project_id = text(&input, "projectId");
        let status = optional_text(&input, "status").unwrap_or_else(|| "active".into());
        let temporary = input.get("temporary").and_then(Value::as_bool).unwrap_or(false);
        let review_status = optional_text(&input, "reviewStatus").unwrap_or_else(|| "pending".into());
        execute(db, "INSERT INTO decisions(id,project_id,title,status,reason,notes,parent_decision_id,replacement_decision_id,checkpoint_id,temporary,revisit_condition,revisit_date,review_status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", &[&id,&project_id,&text(&input,"title"),&status,&text(&input,"reason"),&text(&input,"notes"),&optional_text(&input,"parentDecisionId"),&optional_text(&input,"replacementDecisionId"),&optional_text(&input,"checkpointId"),&temporary,&text(&input,"revisitCondition"),&optional_text(&input,"revisitDate"),&review_status])?;
        set_memory_relations(db, "decision", &id, &project_id, &input)?;
        set_assumption_relations(db, "decision", &id, &input)?;
        decision(db, &id)?.ok_or("Decision not found.".into())
    })
}

#[tauri::command]
fn update_decision(state: State<AppState>, input: Value) -> Result<Value, String> {
    with_db(&state, |db| {
        let id = text(&input, "id");
        let old = decision(db, &id)?.ok_or("Decision not found.")?;
        let string_value = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_else(|| old[key].as_str().unwrap_or_default()).to_string();
        let optional_value = |key: &str| if input.get(key).is_some() { optional_text(&input, key) } else { old[key].as_str().map(str::to_string) };
        let temporary = input.get("temporary").and_then(Value::as_bool).unwrap_or_else(|| old["temporary"].as_bool().unwrap_or(false));
        execute(db, "UPDATE decisions SET title=?1,status=?2,reason=?3,notes=?4,parent_decision_id=?5,replacement_decision_id=?6,checkpoint_id=?7,temporary=?8,revisit_condition=?9,revisit_date=?10,review_status=?11,updated_at=datetime('now') WHERE id=?12", &[&string_value("title"),&string_value("status"),&string_value("reason"),&string_value("notes"),&optional_value("parentDecisionId"),&optional_value("replacementDecisionId"),&optional_value("checkpointId"),&temporary,&string_value("revisitCondition"),&optional_value("revisitDate"),&string_value("reviewStatus"),&id])?;
        let project_id = old["projectId"].as_str().unwrap_or_default();
        set_memory_relations(db, "decision", &id, project_id, &input)?;
        set_assumption_relations(db, "decision", &id, &input)?;
        decision(db, &id)?.ok_or("Decision not found.".into())
    })
}
#[tauri::command] fn delete_decision(state:State<AppState>,decision_id:String)->Result<(),String>{with_db(&state,|db|execute(db,"DELETE FROM decisions WHERE id=?1",&[&decision_id]))}

#[tauri::command]
fn list_assumptions(state: State<AppState>, project_id: String) -> Result<Vec<Value>, String> {
    with_db(&state, |db| {
        let ids = query_ids(db, "SELECT id FROM assumptions WHERE project_id=?1 ORDER BY created_at ASC,rowid ASC", &project_id)?;
        ids.iter().map(|id| assumption(db, id).map(|value| value.unwrap())).collect()
    })
}

#[tauri::command]
fn create_assumption(state: State<AppState>, input: Value) -> Result<Value, String> {
    with_db(&state, |db| {
        let statement = text(&input, "statement");
        if statement.is_empty() { return Err("Assumption statement is required.".into()); }
        let id = Uuid::new_v4().to_string();
        let status = optional_text(&input, "status").unwrap_or_else(|| "active".into());
        let invalidated_at = (status == "invalidated").then(|| Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S").to_string());
        execute(db, "INSERT INTO assumptions(id,project_id,statement,status,notes,invalidated_at) VALUES(?1,?2,?3,?4,?5,?6)", &[&id,&text(&input,"projectId"),&statement,&status,&text(&input,"notes"),&invalidated_at])?;
        assumption(db, &id)?.ok_or("Assumption not found.".into())
    })
}

#[tauri::command]
fn update_assumption(state: State<AppState>, input: Value) -> Result<Value, String> {
    with_db(&state, |db| {
        let id = text(&input, "id");
        let old = assumption(db, &id)?.ok_or("Assumption not found.")?;
        let status = input.get("status").and_then(Value::as_str).unwrap_or_else(|| old["status"].as_str().unwrap_or("active")).to_string();
        let notes = input.get("notes").and_then(Value::as_str).unwrap_or_else(|| old["notes"].as_str().unwrap_or_default()).to_string();
        execute(db, "UPDATE assumptions SET status=?1,notes=?2,invalidated_at=CASE WHEN ?1='invalidated' THEN COALESCE(invalidated_at,datetime('now')) ELSE NULL END WHERE id=?3", &[&status,&notes,&id])?;
        assumption(db, &id)?.ok_or("Assumption not found.".into())
    })
}

#[tauri::command]
fn list_experiments(state: State<AppState>, project_id: String) -> Result<Vec<Value>, String> {
    with_db(&state, |db| {
        let ids = query_ids(db, "SELECT id FROM experiments WHERE project_id=?1 ORDER BY experiment_date DESC,created_at DESC,rowid DESC", &project_id)?;
        ids.iter().map(|id| experiment(db, id).map(|value| value.unwrap())).collect()
    })
}

#[tauri::command]
fn create_experiment(state: State<AppState>, input: Value) -> Result<Value, String> {
    with_db(&state, |db| {
        let title = text(&input, "title");
        if title.is_empty() { return Err("Experiment title is required.".into()); }
        let id = Uuid::new_v4().to_string();
        let project_id = text(&input, "projectId");
        let status = optional_text(&input, "status").unwrap_or_else(|| "planned".into());
        let experiment_date = optional_text(&input, "experimentDate").unwrap_or_else(|| Utc::now().date_naive().to_string());
        execute(db, "INSERT INTO experiments(id,project_id,title,hypothesis,tested,method,result,conclusion,status,experiment_date,resulting_decision_id,notes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)", &[&id,&project_id,&title,&text(&input,"hypothesis"),&text(&input,"tested"),&text(&input,"method"),&text(&input,"result"),&text(&input,"conclusion"),&status,&experiment_date,&optional_text(&input,"resultingDecisionId"),&text(&input,"notes")])?;
        set_memory_relations(db, "experiment", &id, &project_id, &input)?;
        set_assumption_relations(db, "experiment", &id, &input)?;
        experiment(db, &id)?.ok_or("Experiment not found.".into())
    })
}

#[tauri::command]
fn update_experiment(state: State<AppState>, input: Value) -> Result<Value, String> {
    with_db(&state, |db| {
        let id = text(&input, "id");
        let old = experiment(db, &id)?.ok_or("Experiment not found.")?;
        let string_value = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_else(|| old[key].as_str().unwrap_or_default()).to_string();
        let resulting_decision = if input.get("resultingDecisionId").is_some() { optional_text(&input, "resultingDecisionId") } else { old["resultingDecisionId"].as_str().map(str::to_string) };
        execute(db, "UPDATE experiments SET title=?1,hypothesis=?2,tested=?3,method=?4,result=?5,conclusion=?6,status=?7,experiment_date=?8,resulting_decision_id=?9,notes=?10,updated_at=datetime('now') WHERE id=?11", &[&string_value("title"),&string_value("hypothesis"),&string_value("tested"),&string_value("method"),&string_value("result"),&string_value("conclusion"),&string_value("status"),&string_value("experimentDate"),&resulting_decision,&string_value("notes"),&id])?;
        let project_id = old["projectId"].as_str().unwrap_or_default();
        set_memory_relations(db, "experiment", &id, project_id, &input)?;
        set_assumption_relations(db, "experiment", &id, &input)?;
        experiment(db, &id)?.ok_or("Experiment not found.".into())
    })
}

#[tauri::command] fn delete_experiment(state:State<AppState>,experiment_id:String)->Result<(),String>{with_db(&state,|db|execute(db,"DELETE FROM experiments WHERE id=?1",&[&experiment_id]))}

#[tauri::command]
fn get_edi_insights(state: State<AppState>, project_id: String) -> Result<Value, String> {
    with_db(&state, |db| {
        let rows = |sql: &str| -> Result<Vec<Value>, String> {
            let mut statement = db.prepare(sql).map_err(|error| error.to_string())?;
            let items = statement.query_map([&project_id], |row| Ok(json!({
                "kind":row.get::<_,String>(0)?, "id":row.get::<_,String>(1)?, "title":row.get::<_,String>(2)?,
                "status":row.get::<_,String>(3)?, "detail":row.get::<_,String>(4)?,
            }))).map_err(|error| error.to_string())?;
            items.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
        };
        let failure = rows("SELECT kind,id,title,status,reason FROM failure_memory WHERE project_id=?1 ORDER BY datetime(occurred_at) DESC")?;
        let debt = rows("SELECT 'decision',id,title,review_status,CASE WHEN overdue=1 THEN 'revisit date reached' ELSE revisit_condition END FROM decision_debt WHERE project_id=?1 ORDER BY overdue DESC,datetime(created_at)")?;
        let conflicts = rows("SELECT memory_kind,memory_id,title,status,statement FROM explicit_memory_conflicts WHERE project_id=?1 ORDER BY title")?;
        Ok(json!({"failureMemory":failure,"decisionDebt":debt,"explicitConflicts":conflicts}))
    })
}

#[tauri::command]
fn get_why_context(state: State<AppState>, project_id: String, kind: String, memory_id: String) -> Result<Vec<Value>, String> {
    with_db(&state, |db| {
        let mut statement = db.prepare(
            "WITH RECURSIVE why(kind,id,title,depth,path,relation) AS (\
             SELECT ?2,?3,COALESCE((SELECT title FROM project_memory_timeline WHERE project_id=?1 AND kind=?2 AND id=?3),?3),0,'|'||?2||':'||?3||'|','starting-point' \
             UNION ALL SELECT r.target_kind,r.target_id,t.title,why.depth+1,why.path||r.target_kind||':'||r.target_id||'|',r.relation \
             FROM why JOIN edi_memory_relationships r ON r.project_id=?1 AND r.source_kind=why.kind AND r.source_id=why.id \
             JOIN project_memory_timeline t ON t.project_id=r.project_id AND t.kind=r.target_kind AND t.id=r.target_id \
             WHERE why.depth<8 AND instr(why.path,'|'||r.target_kind||':'||r.target_id||'|')=0) \
             SELECT kind,id,title,depth,relation FROM why ORDER BY depth,id"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![project_id, kind, memory_id], |row| Ok(json!({
            "kind":row.get::<_,String>(0)?, "id":row.get::<_,String>(1)?, "title":row.get::<_,String>(2)?,
            "depth":row.get::<_,i64>(3)?, "relation":row.get::<_,String>(4)?,
        }))).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
}

#[tauri::command] fn list_research(state:State<AppState>,project_id:String)->Result<Vec<Value>,String>{with_db(&state,|db|{let ids=query_ids(db,"SELECT id FROM research_items WHERE project_id=?1 ORDER BY created_at DESC,rowid DESC",&project_id)?;ids.iter().map(|id|research(db,id).map(|v|v.unwrap())).collect()})}
#[tauri::command]
fn create_research_item(state: State<AppState>, input: Value) -> Result<Value, String> {
    let project_id = text(&input, "projectId");
    let location = persist_media_location(&project_id, optional_text(&input, "pathOrUrl"))?;
    with_db(&state, |db| {
        let id = Uuid::new_v4().to_string();
        execute(db, "INSERT INTO research_items(id,project_id,type,title,path_or_url,notes) VALUES(?1,?2,?3,?4,?5,?6)", &[&id, &project_id, &text(&input,"type"), &text(&input,"title"), &location, &text(&input,"notes")])?;
        for entry_id in strings(&input, "entryIds") {
            execute(db, "INSERT OR IGNORE INTO research_links(research_id,entry_id) VALUES(?1,?2)", &[&id, &entry_id])?;
        }
        research(db, &id)?.ok_or("Research item not found.".into())
    })
}

#[tauri::command]
fn delete_research_item(state: State<AppState>, research_id: String) -> Result<(), String> {
    with_db(&state, |db| {
        let location: Option<String> = db.query_row("SELECT path_or_url FROM research_items WHERE id=?1", [&research_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.flatten();
        execute(db, "DELETE FROM research_items WHERE id=?1", &[&research_id])?;
        if let Some(location) = location { remove_managed_media_file(&location); }
        Ok(())
    })
}

fn query_ids(db:&Connection,sql:&str,id:&str)->Result<Vec<String>,String>{let mut s=db.prepare(sql).map_err(|e|e.to_string())?;let rows=s.query_map([id],|r|r.get(0)).map_err(|e|e.to_string())?;rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())}

#[tauri::command] fn list_memory_timeline(state:State<AppState>,project_id:String)->Result<Vec<Value>,String>{with_db(&state,|db|{let mut s=db.prepare("SELECT id,project_id,kind,title,occurred_at FROM project_memory_timeline WHERE project_id=?1 ORDER BY datetime(occurred_at) DESC LIMIT 12").map_err(|e|e.to_string())?;let rows=s.query_map([project_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"title":r.get::<_,String>(3)?,"occurredAt":r.get::<_,String>(4)?}))).map_err(|e|e.to_string())?;rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())})}

fn inactive_days(value: &str) -> i64 {
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return (Utc::now().signed_duration_since(date.with_timezone(&Utc))).num_days().max(0);
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .map(|date| (Utc::now().naive_utc() - date).num_days().max(0))
        .unwrap_or(0)
}

#[tauri::command]
fn get_resume_context(state: State<AppState>, project_id: String) -> Result<Value, String> {
    with_db(&state, |db| {
        let p = project(db, &project_id)?.ok_or("project not found.")?;
        let cps = query_ids(db, "SELECT id FROM checkpoints WHERE project_id=?1 ORDER BY created_at DESC,rowid DESC", &project_id)?;
        let latest = if let Some(id) = cps.first() { checkpoint(db, id)? } else { None };
        let since = latest.as_ref().and_then(|v| v["createdAt"].as_str()).unwrap_or(p["createdAt"].as_str().unwrap());
        let dids = query_ids(db, "SELECT id FROM decisions WHERE project_id=?1 AND status IN ('active','experimental') ORDER BY updated_at DESC", &project_id)?;
        let active = dids.iter().map(|id| decision(db, id).map(|v| v.unwrap())).collect::<Result<Vec<_>, _>>()?;
        let mut statement = db.prepare("SELECT id FROM entries WHERE project_id=?1 AND created_at>?2 ORDER BY created_at DESC LIMIT 8").map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![project_id, since], |r| r.get(0)).map_err(|e| e.to_string())?;
        let eids = rows.collect::<Result<Vec<String>, _>>().map_err(|e| e.to_string())?;
        let recent = eids.iter().map(|id| entry(db, id).map(|v| v.unwrap())).collect::<Result<Vec<_>, _>>()?;
        let commits: i64 = db.query_row("SELECT COUNT(*) FROM commits_cache WHERE project_id=?1 AND datetime(date)>datetime(?2)", params![project_id, since], |r| r.get(0)).map_err(|e| e.to_string())?;
        let research_count: i64 = db.query_row("SELECT COUNT(*) FROM research_items WHERE project_id=?1", [&project_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let experiment_count: i64 = db.query_row("SELECT COUNT(*) FROM experiments WHERE project_id=?1", [&project_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let running_ids = query_ids(db, "SELECT id FROM experiments WHERE project_id=?1 AND status IN ('planned','running') ORDER BY experiment_date DESC,created_at DESC", &project_id)?;
        let running_experiments = running_ids.iter().map(|id| experiment(db, id).map(|value| value.unwrap())).collect::<Result<Vec<_>, _>>()?;
        let last_active: String = db.query_row(
            "SELECT MAX(activity_at) FROM (SELECT created_at activity_at FROM projects WHERE id=?1 UNION ALL SELECT updated_at FROM entries WHERE project_id=?1 UNION ALL SELECT created_at FROM checkpoints WHERE project_id=?1 UNION ALL SELECT updated_at FROM decisions WHERE project_id=?1 UNION ALL SELECT created_at FROM research_items WHERE project_id=?1 UNION ALL SELECT updated_at FROM experiments WHERE project_id=?1 UNION ALL SELECT created_at FROM assumptions WHERE project_id=?1)",
            [&project_id], |r| r.get::<_, Option<String>>(0)
        ).map_err(|e| e.to_string())?.unwrap_or_else(|| p["createdAt"].as_str().unwrap().to_string());
        let next = latest.as_ref().and_then(|v| v["nextStep"].as_str()).filter(|v| !v.is_empty()).map(str::to_string)
            .or_else(|| latest.as_ref().and_then(|v| v["openQuestions"].as_str()).filter(|v| !v.is_empty()).map(str::to_string))
            .or_else(|| active.first().and_then(|v| v["reason"].as_str()).filter(|v| !v.is_empty()).map(str::to_string))
            .unwrap_or_else(|| "create a checkpoint to preserve the current mental state.".to_string());
        Ok(json!({"lastActiveAt":last_active,"inactiveDays":inactive_days(&last_active),"latestCheckpoint":latest,"activeDecisions":active,"recentEntries":recent,"commitsSinceCheckpoint":commits,"changedFiles":p["lastChangedFiles"],"researchCount":research_count,"experimentCount":experiment_count,"runningExperiments":running_experiments,"suggestedNextStep":next}))
    })
}

fn run_git(path:&Path,args:&[&str])->Option<String>{let out=Command::new("git").args(args).current_dir(path).output().ok()?;if out.status.success(){Some(String::from_utf8_lossy(&out.stdout).trim().to_string())}else{None}}
fn git_status(path:&Path)->Value{if run_git(path,&["rev-parse","--is-inside-work-tree"]).as_deref()!=Some("true"){return json!({"state":"not-repository","headHash":null,"workingTreeClean":true,"changedFiles":0,"untrackedFiles":0,"summary":"folder is not a Git repository"})}let raw=run_git(path,&["status","--porcelain"]).unwrap_or_default();let lines:Vec<_>=raw.lines().collect();let untracked=lines.iter().filter(|v|v.starts_with("??")).count();json!({"state":"ok","headHash":run_git(path,&["rev-parse","HEAD"]),"workingTreeClean":lines.is_empty(),"changedFiles":lines.len(),"untrackedFiles":untracked,"summary":if lines.is_empty(){"working tree is clean".into()}else{format!("{} changed file(s), {} untracked file(s)",lines.len(),untracked)}})}
fn git_commits(path:&Path)->Vec<Value>{run_git(path,&["log","-100","--format=%H%x1f%s%x1f%an%x1f%aI%x1e"]).unwrap_or_default().split('\u{1e}').filter_map(|line|{let v:Vec<_>=line.trim().split('\u{1f}').collect();(v.len()==4).then(||json!({"hash":v[0],"message":v[1],"author":v[2],"date":v[3]}))}).collect()}
fn refresh_git(db: &Connection, id: &str, path: &Path) -> Result<Value, String> {
    let previous_head: Option<String> = db.query_row("SELECT last_head_hash FROM projects WHERE id=?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let status = git_status(path);
    let remote = run_git(path, &["remote", "get-url", "origin"]);
    let commits = if status["state"] == "ok" { git_commits(path) } else { vec![] };
    let current_head = status["headHash"].as_str();

    if let (Some(previous), Some(current)) = (previous_head.as_deref(), current_head) {
        if previous != current {
            let new_commits: Vec<&Value> = commits.iter().take_while(|commit| commit["hash"].as_str() != Some(previous)).collect();
            let entry_id = Uuid::new_v4().to_string();
            let title = if new_commits.len() == 1 {
                new_commits[0]["message"].as_str().unwrap_or("new commit").to_string()
            } else {
                format!("{} new commits", new_commits.len().max(1))
            };
            let mut body = format!("HEAD changed from {previous} to {current}.\n\n## new commits");
            for commit in &new_commits {
                body.push_str(&format!("\n- {} {}", &commit["hash"].as_str().unwrap_or_default()[..7.min(commit["hash"].as_str().unwrap_or_default().len())], commit["message"].as_str().unwrap_or_default()));
            }
            execute(db, "INSERT INTO entries(id,project_id,title,body_md,source) VALUES(?1,?2,?3,?4,'auto')", &[&entry_id, &id, &title, &body])?;
            for commit in new_commits {
                if let Some(hash) = commit["hash"].as_str() { execute(db, "INSERT OR IGNORE INTO entry_commits(entry_id,commit_hash,project_id) VALUES(?1,?2,?3)", &[&entry_id, &hash, &id])?; }
            }
        }
    }

    execute(db,"UPDATE projects SET git_remote=?1,last_checked_at=datetime('now'),last_head_hash=?2,last_working_tree_clean=?3,git_status=?4,last_changed_files=?5,last_untracked_files=?6 WHERE id=?7",&[&remote,&current_head,&(status["workingTreeClean"]==true),&status["state"].as_str(),&status["changedFiles"].as_i64(),&status["untrackedFiles"].as_i64(),&id])?;
    for commit in &commits { let cache_id=Uuid::new_v4().to_string(); execute(db,"INSERT OR IGNORE INTO commits_cache(id,project_id,hash,message,author,date) VALUES(?1,?2,?3,?4,?5,?6)",&[&cache_id,&id,&commit["hash"].as_str(),&commit["message"].as_str(),&commit["author"].as_str(),&commit["date"].as_str()])?; }
    Ok(json!({"gitRemote":remote,"commits":commits,"status":status}))
}
#[tauri::command] fn refresh_git_metadata(state:State<AppState>,input:Value)->Result<Value,String>{with_db(&state,|db|{let id=text(&input,"projectId");let p=project(db,&id)?.ok_or("Project not found.")?;refresh_git(db,&id,Path::new(p["path"].as_str().unwrap()))})}
#[tauri::command] fn get_commits(state:State<AppState>,project_id:String)->Result<Vec<Value>,String>{with_db(&state,|db|{let mut s=db.prepare("SELECT hash,message,author,date FROM commits_cache WHERE project_id=?1 ORDER BY date DESC").map_err(|e|e.to_string())?;let rows=s.query_map([project_id],|r|Ok(json!({"hash":r.get::<_,String>(0)?,"message":r.get::<_,String>(1)?,"author":r.get::<_,String>(2)?,"date":r.get::<_,String>(3)?}))).map_err(|e|e.to_string())?;rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())})}

#[tauri::command]
fn analyze_project_xray(state: State<AppState>, project_id: String) -> Result<Value, String> {
    with_db(&state, |db| {
        let project = project(db, &project_id)?.ok_or("Project not found.")?;
        let root = Path::new(project["path"].as_str().ok_or("Project path is unavailable.")?);
        let report = xray::analyze_project(root);
        let mut value = serde_json::to_value(report).map_err(|error| error.to_string())?;
        if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
            for node in nodes {
                let name = node["name"].as_str().unwrap_or_default();
                node["memoryLinks"] = json!(xray_memory_links(db, &project_id, name)?);
            }
        }
        Ok(value)
    })
}

#[tauri::command]
fn simulate_xray_removal(state: State<AppState>, project_id: String, dependency_id: String) -> Result<Value, String> {
    with_db(&state, |db| {
        let project = project(db, &project_id)?.ok_or("Project not found.")?;
        let root = Path::new(project["path"].as_str().ok_or("Project path is unavailable.")?);
        let report = xray::analyze_project(root);
        serde_json::to_value(xray::simulate_removal(&report, &dependency_id)?).map_err(|error| error.to_string())
    })
}

#[tauri::command]
fn set_xray_memory_links(state: State<AppState>, input: Value) -> Result<(), String> {
    with_db(&state, |db| {
        let project_id = text(&input, "projectId");
        let dependency_name = text(&input, "dependencyName");
        if project_id.is_empty() || dependency_name.is_empty() { return Err("Project and dependency are required.".into()); }
        execute(db, "DELETE FROM xray_memory_links WHERE project_id=?1 AND dependency_name=?2", &[&project_id, &dependency_name])?;
        for link in input.get("links").and_then(Value::as_array).into_iter().flatten() {
            let kind = text(link, "kind");
            let memory_id = text(link, "id");
            if !["journal", "checkpoint", "decision", "research", "experiment", "assumption"].contains(&kind.as_str()) { continue; }
            let exists: i64 = db.query_row(
                "SELECT COUNT(*) FROM project_memory_timeline WHERE project_id=?1 AND kind=?2 AND id=?3",
                params![project_id, kind, memory_id],
                |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if exists > 0 {
                execute(db, "INSERT OR IGNORE INTO xray_memory_links(project_id,dependency_name,memory_kind,memory_id) VALUES(?1,?2,?3,?4)", &[&project_id, &dependency_name, &kind, &memory_id])?;
            }
        }
        Ok(())
    })
}

fn open_database() -> Result<Connection, String> {
    let config = dirs::config_dir().ok_or("Cannot resolve application data directory.")?;
    let legacy = config.join("@developer-journal").join("desktop").join("developer-journal.sqlite");
    let previous = config.join("Project Memory").join("project-memory.sqlite");
    let base = config.join("EDI Developer Journal");
    fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    let path = if legacy.exists() { legacy } else if previous.exists() { previous } else { base.join("edi-developer-journal.sqlite") };
    let mut db = Connection::open(path).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").map_err(|error| error.to_string())?;
    db.execute("CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT(datetime('now')))", []).map_err(|error| error.to_string())?;
    for (name, sql) in [
        ("001_initial.sql", include_str!("../../packages/core/src/db/migrations/001_initial.sql")),
        ("002_git_state.sql", include_str!("../../packages/core/src/db/migrations/002_git_state.sql")),
        ("003_git_status.sql", include_str!("../../packages/core/src/db/migrations/003_git_status.sql")),
        ("004_project_memory.sql", include_str!("../../packages/core/src/db/migrations/004_project_memory.sql")),
        ("005_project_xray.sql", include_str!("../../packages/core/src/db/migrations/005_project_xray.sql")),
        ("006_engineering_memory.sql", include_str!("../../packages/core/src/db/migrations/006_engineering_memory.sql")),
    ] {
        let exists: i64 = db.query_row("SELECT COUNT(*) FROM _migrations WHERE name=?1", [name], |row| row.get(0)).map_err(|error| error.to_string())?;
        if exists > 0 { continue; }
        let transaction = db.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(sql).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO _migrations(name) VALUES(?1)", [name]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    migrate_research_attachments(&db);
    Ok(db)
}

#[cfg(test)]
mod relocation_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn finds_a_uniquely_matching_moved_repository() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("edi-relocation-{suffix}"));
        let repository = root.join("renamed-parent").join("databridge");
        fs::create_dir_all(&repository).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "edi@example.test"],
            vec!["config", "user.name", "EDI Test"],
        ] { assert!(Command::new("git").args(args).current_dir(&repository).status().unwrap().success()); }
        fs::write(repository.join("README.md"), "test").unwrap();
        assert!(Command::new("git").args(["add", "README.md"]).current_dir(&repository).status().unwrap().success());
        assert!(Command::new("git").args(["commit", "-m", "initial"]).current_dir(&repository).status().unwrap().success());
        let head = run_git(&repository, &["rev-parse", "HEAD"]).unwrap();
        let old_path = root.join("old-parent").join("databridge");

        let found = find_relocated_project(&old_path, "databridge", &head, None);

        assert_eq!(found, Some(repository));
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod attachment_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn copies_local_media_into_managed_storage() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("edi-attachments-{suffix}"));
        let source = root.join("source.png");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, b"saved image").unwrap();

        let stored = persist_media_file_in(&root.join("managed"), "project-1", source.to_str().unwrap()).unwrap();
        let stored = PathBuf::from(stored);

        assert!(stored.starts_with(root.join("managed").join("project-1")));
        assert_eq!(fs::read(stored).unwrap(), b"saved image");
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;

    fn memory_database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        for sql in [
            include_str!("../../packages/core/src/db/migrations/001_initial.sql"),
            include_str!("../../packages/core/src/db/migrations/002_git_state.sql"),
            include_str!("../../packages/core/src/db/migrations/003_git_status.sql"),
            include_str!("../../packages/core/src/db/migrations/004_project_memory.sql"),
            include_str!("../../packages/core/src/db/migrations/005_project_xray.sql"),
            include_str!("../../packages/core/src/db/migrations/006_engineering_memory.sql"),
        ] { db.execute_batch(sql).unwrap(); }
        db.execute("INSERT INTO projects(id,name,path) VALUES('target','Target','C:/target')", []).unwrap();
        db
    }

    #[test]
    fn imports_memory_and_skips_the_same_items_on_repeat() {
        let db = memory_database();
        let export = json!({
            "format":"edi-developer-journal", "schemaVersion":1,
            "notes":[{"id":"note-1","title":"note","bodyMd":"body","tags":["test"],"commitHashes":["abc"]}],
            "research":[{"id":"research-1","type":"link","title":"source","pathOrUrl":"https://example.test","notes":"","entryIds":["note-1"]}],
            "assumptions":[{"id":"assumption-1","statement":"works","status":"active","notes":""}],
            "checkpoints":[{"id":"checkpoint-1","title":"state","entryIds":["note-1"],"researchIds":["research-1"]}],
            "decisions":[{"id":"decision-1","title":"choose it","status":"active","checkpointId":"checkpoint-1","assumptionIds":["assumption-1"]}],
            "experiments":[{"id":"experiment-1","title":"try it","status":"successful","experimentDate":"2026-09-13","resultingDecisionId":"decision-1","assumptionIds":["assumption-1"]}],
            "xrayMemoryLinks":[{"dependencyName":"serde","memoryKind":"journal","memoryId":"note-1"}]
        });

        assert_eq!(import_project_memory(&db, "target", &export).unwrap(), 6);
        assert_eq!(import_project_memory(&db, "target", &export).unwrap(), 0);
        let memory_count: i64 = db.query_row("SELECT COUNT(*) FROM project_memory_timeline WHERE project_id='target'", [], |row| row.get(0)).unwrap();
        let xray_count: i64 = db.query_row("SELECT COUNT(*) FROM xray_memory_links WHERE project_id='target'", [], |row| row.get(0)).unwrap();
        let assumption_link_count: i64 = db.query_row("SELECT COUNT(*) FROM decision_assumptions WHERE decision_id='decision-1'", [], |row| row.get(0)).unwrap();
        assert_eq!(memory_count, 6);
        assert_eq!(xray_count, 1);
        assert_eq!(assumption_link_count, 1);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(){let result=open_database();let (db,db_error)=match result{Ok(db)=>(Some(db),None),Err(e)=>(None,Some(e))};tauri::Builder::default().manage(AppState{db:Mutex::new(db),db_error}).setup(|app|{if let Some(window)=app.get_webview_window("main"){let icon=tauri::image::Image::new(include_bytes!("../icons/128x128.rgba"),128,128);window.set_icon(icon)?;}Ok(())}).invoke_handler(tauri::generate_handler![get_app_status,list_projects,auto_relocate_projects,get_project,update_project_name,delete_project,create_project,open_project_path,relocate_project,choose_project_path,choose_media_file,open_media_location,get_data_directory,export_project_data,import_project_data,list_entries,create_entry,update_entry,delete_entry,list_checkpoints,create_checkpoint,delete_checkpoint,list_decisions,create_decision,update_decision,delete_decision,list_assumptions,create_assumption,update_assumption,list_experiments,create_experiment,update_experiment,delete_experiment,get_edi_insights,get_why_context,get_resume_context,list_memory_timeline,list_research,create_research_item,delete_research_item,refresh_git_metadata,get_commits,analyze_project_xray,simulate_xray_removal,set_xray_memory_links]).run(tauri::generate_context!()).expect("error while running EDI Developer Journal");}
