use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyNode {
    pub id: String,
    pub name: String,
    pub version: String,
    pub direct: bool,
    pub direct_kind: Option<String>,
    pub resolved: bool,
    pub children: Vec<String>,
    pub parent_ids: Vec<String>,
    pub used_by: Vec<String>,
    pub transitive_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdge {
    pub from: String,
    pub to: String,
    pub source: String,
    pub confirmed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrayReport {
    pub ecosystem: String,
    pub manifest_path: Option<String>,
    pub lockfile_path: Option<String>,
    pub nodes: Vec<DependencyNode>,
    pub edges: Vec<DependencyEdge>,
    pub root_dependency_ids: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalSimulation {
    pub dependency_id: String,
    pub confirmed_source_files: Vec<String>,
    pub confirmed_relationships: Vec<String>,
    pub affected_branch_ids: Vec<String>,
    pub possibly_removable_ids: Vec<String>,
    pub possible_impact: Vec<String>,
}

#[derive(Clone)]
struct NodeDraft {
    name: String,
    version: String,
    direct: bool,
    direct_kind: Option<String>,
    resolved: bool,
}

pub fn analyze_project(root: &Path) -> XrayReport {
    let manifest = root.join("package.json");
    if !manifest.is_file() {
        return XrayReport {
            ecosystem: "none".into(),
            manifest_path: None,
            lockfile_path: None,
            nodes: vec![],
            edges: vec![],
            root_dependency_ids: vec![],
            warnings: vec![
                "package.json was not found. npm dependency analysis is unavailable.".into(),
            ],
        };
    }

    let mut warnings = Vec::new();
    let manifest_value = match read_json(&manifest) {
        Ok(value) => value,
        Err(error) => {
            return XrayReport {
                ecosystem: "npm".into(),
                manifest_path: Some("package.json".into()),
                lockfile_path: None,
                nodes: vec![],
                edges: vec![],
                root_dependency_ids: vec![],
                warnings: vec![format!("package.json could not be parsed: {error}")],
            }
        }
    };
    let direct = direct_dependencies(&manifest_value);
    let lock_path = root.join("package-lock.json");
    let mut drafts = HashMap::<String, NodeDraft>::new();
    let mut edge_pairs = BTreeSet::<(String, String)>::new();

    if lock_path.is_file() {
        match read_json(&lock_path) {
            Ok(lock) => {
                if lock.get("packages").and_then(Value::as_object).is_some() {
                    parse_modern_lock(&lock, &direct, &mut drafts, &mut edge_pairs);
                } else if let Some(dependencies) =
                    lock.get("dependencies").and_then(Value::as_object)
                {
                    parse_legacy_dependencies(
                        dependencies,
                        "",
                        &direct,
                        &mut drafts,
                        &mut edge_pairs,
                    );
                } else {
                    warnings.push("package-lock.json contains no dependency map.".into());
                }
            }
            Err(error) => warnings.push(format!("package-lock.json could not be parsed: {error}")),
        }
    } else {
        warnings.push(
            "package-lock.json was not found; only direct manifest dependencies are shown.".into(),
        );
    }

    for (name, (version, kind)) in &direct {
        let id = resolve_dependency_id(&drafts, "", name)
            .unwrap_or_else(|| format!("node_modules/{name}"));
        let draft = drafts.entry(id).or_insert_with(|| NodeDraft {
            name: name.clone(),
            version: version.clone(),
            direct: true,
            direct_kind: Some(kind.clone()),
            resolved: false,
        });
        draft.direct = true;
        draft.direct_kind = Some(kind.clone());
    }

    let direct_names: HashSet<String> = direct.keys().cloned().collect();
    let usage = scan_source_usage(root, &direct_names);
    let mut children = HashMap::<String, BTreeSet<String>>::new();
    let mut parents = HashMap::<String, BTreeSet<String>>::new();
    for (from, to) in &edge_pairs {
        children.entry(from.clone()).or_default().insert(to.clone());
        parents.entry(to.clone()).or_default().insert(from.clone());
    }

    let mut nodes: Vec<DependencyNode> = drafts
        .iter()
        .map(|(id, draft)| DependencyNode {
            id: id.clone(),
            name: draft.name.clone(),
            version: draft.version.clone(),
            direct: draft.direct,
            direct_kind: draft.direct_kind.clone(),
            resolved: draft.resolved,
            children: children
                .get(id)
                .map(|v| v.iter().cloned().collect())
                .unwrap_or_default(),
            parent_ids: parents
                .get(id)
                .map(|v| v.iter().cloned().collect())
                .unwrap_or_default(),
            used_by: usage.get(&draft.name).cloned().unwrap_or_default(),
            transitive_count: descendant_ids(id, &children).len(),
        })
        .collect();
    nodes.sort_by(|a, b| {
        (!a.direct, &a.name, &a.version, &a.id).cmp(&(!b.direct, &b.name, &b.version, &b.id))
    });
    let root_dependency_ids = nodes
        .iter()
        .filter(|node| node.direct)
        .map(|node| node.id.clone())
        .collect();
    let edges = edge_pairs
        .into_iter()
        .map(|(from, to)| DependencyEdge {
            from,
            to,
            source: "package-lock.json".into(),
            confirmed: true,
        })
        .collect();

    XrayReport {
        ecosystem: "npm".into(),
        manifest_path: Some("package.json".into()),
        lockfile_path: lock_path.is_file().then(|| "package-lock.json".into()),
        nodes,
        edges,
        root_dependency_ids,
        warnings,
    }
}

pub fn simulate_removal(
    report: &XrayReport,
    dependency_id: &str,
) -> Result<RemovalSimulation, String> {
    let by_id: HashMap<&str, &DependencyNode> = report
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let target = by_id
        .get(dependency_id)
        .ok_or_else(|| "Dependency was not found in the current X-Ray report.".to_string())?;
    let child_map: HashMap<String, BTreeSet<String>> = report
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node.children.iter().cloned().collect()))
        .collect();
    let affected = descendant_ids(dependency_id, &child_map);
    let branch: HashSet<&str> = affected
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(dependency_id))
        .collect();
    let mut possible = Vec::new();
    for id in &affected {
        if let Some(node) = by_id.get(id.as_str()) {
            let only_inside_branch = !node.parent_ids.is_empty()
                && node
                    .parent_ids
                    .iter()
                    .all(|parent| branch.contains(parent.as_str()));
            if !node.direct && only_inside_branch {
                possible.push(id.clone());
            }
        }
    }
    possible.sort();
    let mut confirmed_relationships = Vec::new();
    if target.direct {
        confirmed_relationships.push(format!(
            "{} is declared directly in package.json.",
            target.name
        ));
    }
    for parent in &target.parent_ids {
        if let Some(node) = by_id.get(parent.as_str()) {
            confirmed_relationships.push(format!(
                "{} depends on {} according to package-lock.json.",
                node.name, target.name
            ));
        }
    }
    let possible_impact = if possible.is_empty() {
        vec!["No exclusively owned transitive packages were identified. Shared or runtime-only usage may still exist.".into()]
    } else {
        vec![format!("{} transitive package(s) might become unnecessary. This is an inference, not a safe-removal guarantee.", possible.len())]
    };
    Ok(RemovalSimulation {
        dependency_id: dependency_id.into(),
        confirmed_source_files: target.used_by.clone(),
        confirmed_relationships,
        affected_branch_ids: affected.into_iter().collect(),
        possibly_removable_ids: possible,
        possible_impact,
    })
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn direct_dependencies(manifest: &Value) -> BTreeMap<String, (String, String)> {
    let mut result = BTreeMap::new();
    for (section, kind) in [
        ("dependencies", "runtime"),
        ("devDependencies", "development"),
        ("optionalDependencies", "optional"),
    ] {
        if let Some(values) = manifest.get(section).and_then(Value::as_object) {
            for (name, version) in values {
                result
                    .entry(name.clone())
                    .or_insert_with(|| (version.as_str().unwrap_or("unknown").into(), kind.into()));
            }
        }
    }
    result
}

fn package_name_from_path(path: &str, value: &Value) -> String {
    value
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            path.rsplit_once("node_modules/")
                .map(|(_, name)| name)
                .unwrap_or(path)
                .to_string()
        })
}

fn parse_modern_lock(
    lock: &Value,
    direct: &BTreeMap<String, (String, String)>,
    drafts: &mut HashMap<String, NodeDraft>,
    edges: &mut BTreeSet<(String, String)>,
) {
    let packages = match lock.get("packages").and_then(Value::as_object) {
        Some(value) => value,
        None => return,
    };
    for (path, value) in packages {
        if path.is_empty() || !path.contains("node_modules/") {
            continue;
        }
        let name = package_name_from_path(path, value);
        drafts.insert(
            path.clone(),
            NodeDraft {
                name: name.clone(),
                version: value
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .into(),
                direct: false,
                direct_kind: None,
                resolved: value.get("version").is_some(),
            },
        );
    }
    for (path, value) in packages {
        let mut dependency_names = BTreeSet::new();
        for section in ["dependencies", "optionalDependencies"] {
            if let Some(values) = value.get(section).and_then(Value::as_object) {
                dependency_names.extend(values.keys().cloned());
            }
        }
        for name in dependency_names {
            if let Some(child_id) = resolve_dependency_id(drafts, path, &name) {
                if path.is_empty() {
                    if let Some(draft) = drafts.get_mut(&child_id) {
                        draft.direct = true;
                        draft.direct_kind = direct.get(&name).map(|(_, kind)| kind.clone());
                    }
                } else if drafts.contains_key(path) {
                    edges.insert((path.clone(), child_id));
                }
            }
        }
    }
}

fn parse_legacy_dependencies(
    values: &serde_json::Map<String, Value>,
    parent: &str,
    direct: &BTreeMap<String, (String, String)>,
    drafts: &mut HashMap<String, NodeDraft>,
    edges: &mut BTreeSet<(String, String)>,
) {
    for (name, value) in values {
        let id = if parent.is_empty() {
            format!("node_modules/{name}")
        } else {
            format!("{parent}/node_modules/{name}")
        };
        drafts.insert(
            id.clone(),
            NodeDraft {
                name: name.clone(),
                version: value
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .into(),
                direct: parent.is_empty() && direct.contains_key(name),
                direct_kind: (parent.is_empty())
                    .then(|| direct.get(name).map(|(_, kind)| kind.clone()))
                    .flatten(),
                resolved: value.get("version").is_some(),
            },
        );
        if !parent.is_empty() {
            edges.insert((parent.into(), id.clone()));
        }
        if let Some(children) = value.get("dependencies").and_then(Value::as_object) {
            parse_legacy_dependencies(children, &id, direct, drafts, edges);
        }
    }
}

fn resolve_dependency_id(
    drafts: &HashMap<String, NodeDraft>,
    parent: &str,
    name: &str,
) -> Option<String> {
    let mut base = parent.to_string();
    loop {
        let candidate = if base.is_empty() {
            format!("node_modules/{name}")
        } else {
            format!("{base}/node_modules/{name}")
        };
        if drafts.contains_key(&candidate) {
            return Some(candidate);
        }
        if base.is_empty() {
            break;
        }
        base = base
            .rsplit_once("/node_modules/")
            .map(|(prefix, _)| prefix.to_string())
            .unwrap_or_default();
    }
    None
}

fn descendant_ids(id: &str, children: &HashMap<String, BTreeSet<String>>) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    let mut stack: Vec<String> = children
        .get(id)
        .map(|v| v.iter().cloned().collect())
        .unwrap_or_default();
    while let Some(child) = stack.pop() {
        if !result.insert(child.clone()) {
            continue;
        }
        if let Some(next) = children.get(&child) {
            stack.extend(next.iter().cloned());
        }
    }
    result
}

fn scan_source_usage(root: &Path, direct_names: &HashSet<String>) -> HashMap<String, Vec<String>> {
    let mut files = Vec::new();
    collect_source_files(root, root, &mut files);
    let mut usage = HashMap::<String, BTreeSet<String>>::new();
    for file in files {
        let Ok(metadata) = fs::metadata(&file) else {
            continue;
        };
        if metadata.len() > 1_000_000 {
            continue;
        }
        let Ok(source) = fs::read_to_string(&file) else {
            continue;
        };
        let imports = extract_imports(&source);
        let relative = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        for name in direct_names {
            if imports
                .iter()
                .any(|specifier| specifier == name || specifier.starts_with(&format!("{name}/")))
            {
                usage
                    .entry(name.clone())
                    .or_default()
                    .insert(relative.clone());
            }
        }
    }
    usage
        .into_iter()
        .map(|(name, paths)| (name, paths.into_iter().collect()))
        .collect()
}

fn collect_source_files(root: &Path, current: &Path, files: &mut Vec<PathBuf>) {
    if files.len() >= 5000 {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or_default();
            if ![
                "node_modules",
                ".git",
                "dist",
                "build",
                "target",
                ".next",
                "coverage",
            ]
            .contains(&name)
            {
                collect_source_files(root, &path, files);
            }
        } else if matches!(
            path.extension().and_then(|v| v.to_str()),
            Some("js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs")
        ) {
            files.push(path);
        }
        if files.len() >= 5000 {
            break;
        }
    }
    let _ = root;
}

fn extract_imports(source: &str) -> HashSet<String> {
    let mut result = HashSet::new();
    for line in source.lines() {
        for marker in [" from ", "require(", "import("] {
            let mut rest = line;
            while let Some(index) = rest.find(marker) {
                rest = &rest[index + marker.len()..];
                let trimmed = rest.trim_start();
                let Some(quote) = trimmed.chars().next().filter(|c| *c == '\'' || *c == '"') else {
                    break;
                };
                let after_quote = &trimmed[quote.len_utf8()..];
                if let Some(end) = after_quote.find(quote) {
                    result.insert(after_quote[..end].to_string());
                }
                rest = after_quote;
            }
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("import ") && !trimmed.contains(" from ") {
            let after = trimmed.trim_start_matches("import ").trim_start();
            if let Some(quote) = after.chars().next().filter(|c| *c == '\'' || *c == '"') {
                let value = &after[quote.len_utf8()..];
                if let Some(end) = value.find(quote) {
                    result.insert(value[..end].to_string());
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("edi-xray-{name}-{suffix}"));
        fs::create_dir_all(path.join("src")).unwrap();
        path
    }

    #[test]
    fn parses_direct_transitive_reverse_and_usage() {
        let root = fixture("graph");
        fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"alpha":"^1.0.0"}}"#,
        )
        .unwrap();
        fs::write(root.join("package-lock.json"), r#"{"lockfileVersion":3,"packages":{"":{"dependencies":{"alpha":"^1.0.0"}},"node_modules/alpha":{"version":"1.2.0","dependencies":{"beta":"2.0.0"}},"node_modules/beta":{"version":"2.0.0","dependencies":{"gamma":"3.0.0"}},"node_modules/gamma":{"version":"3.0.0"}}}"#).unwrap();
        fs::write(root.join("src/main.ts"), "import alpha from 'alpha';").unwrap();
        let report = analyze_project(&root);
        let alpha = report
            .nodes
            .iter()
            .find(|node| node.name == "alpha")
            .unwrap();
        let beta = report
            .nodes
            .iter()
            .find(|node| node.name == "beta")
            .unwrap();
        assert!(alpha.direct);
        assert_eq!(alpha.transitive_count, 2);
        assert_eq!(alpha.used_by, vec!["src/main.ts"]);
        assert_eq!(beta.parent_ids, vec![alpha.id.clone()]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_and_missing_manifests_are_safe() {
        let root = fixture("missing");
        assert!(analyze_project(&root).nodes.is_empty());
        fs::write(root.join("package.json"), "{").unwrap();
        assert!(analyze_project(&root).warnings[0].contains("could not be parsed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_with_no_dependencies_is_empty() {
        let root = fixture("empty");
        fs::write(root.join("package.json"), r#"{"name":"empty"}"#).unwrap();
        let report = analyze_project(&root);
        assert!(report.nodes.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_simulation_separates_confirmed_and_possible() {
        let root = fixture("remove");
        fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"alpha":"1.0.0"}}"#,
        )
        .unwrap();
        fs::write(root.join("package-lock.json"), r#"{"packages":{"":{"dependencies":{"alpha":"1.0.0"}},"node_modules/alpha":{"version":"1.0.0","dependencies":{"beta":"1.0.0"}},"node_modules/beta":{"version":"1.0.0"}}}"#).unwrap();
        let report = analyze_project(&root);
        let alpha = report
            .nodes
            .iter()
            .find(|node| node.name == "alpha")
            .unwrap();
        let beta = report
            .nodes
            .iter()
            .find(|node| node.name == "beta")
            .unwrap();
        let simulation = simulate_removal(&report, &alpha.id).unwrap();
        assert!(simulation
            .confirmed_relationships
            .iter()
            .any(|line| line.contains("package.json")));
        assert!(simulation.possibly_removable_ids.contains(&beta.id));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn analysis_does_not_modify_the_project() {
        let root = fixture("read-only");
        let manifest = r#"{"dependencies":{"alpha":"1.0.0"}}"#;
        let lock = r#"{"packages":{"":{"dependencies":{"alpha":"1.0.0"}},"node_modules/alpha":{"version":"1.0.0"}}}"#;
        let source = "const alpha = require('alpha');";
        fs::write(root.join("package.json"), manifest).unwrap();
        fs::write(root.join("package-lock.json"), lock).unwrap();
        fs::write(root.join("src/main.js"), source).unwrap();
        let before: BTreeSet<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        let _ = analyze_project(&root);
        let after: BTreeSet<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(before, after);
        assert_eq!(
            fs::read_to_string(root.join("package.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read_to_string(root.join("package-lock.json")).unwrap(),
            lock
        );
        assert_eq!(
            fs::read_to_string(root.join("src/main.js")).unwrap(),
            source
        );
        fs::remove_dir_all(root).unwrap();
    }
}
