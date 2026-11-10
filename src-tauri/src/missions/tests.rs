use super::*;
use crate::workspace::project_roots::ProjectRootRegistry;

/// Contained scratch project with an approved root, mirroring the TempProject
/// pattern from state_load.rs tests.
struct TempProject {
    path: PathBuf,
    _registry: Arc<ProjectRootRegistry>,
}

impl TempProject {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("saple_missions_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(path.join(".saple")).unwrap();
        let registry = Arc::new(ProjectRootRegistry::new());
        registry.register_root(&path).unwrap();
        TempProject {
            path,
            _registry: registry,
        }
    }
    fn project(&self) -> String {
        self.path.to_string_lossy().to_string()
    }
    /// Path helpers used by crash-simulation assertions.
    fn mission_dir(&self, id: &str) -> PathBuf {
        self.path.join(".saple").join("missions").join(id)
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        // Clear any corrupt flag this test planted so later temp projects sharing
        // nothing still behave (flags are keyed by canonical path, but be tidy).
        let root = self.path.join(".saple").join("missions");
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.filter_map(|e| e.ok()) {
                let _ = crate::workspace::fs_lock::clear_corrupt_flag(&entry.path().join("state.json"));
            }
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn create_mission(p: &TempProject, title: &str) -> MissionSummary {
    mission_create_inner(
        &p.project(),
        title,
        "Do the thing",
        MissionOptions::default(),
    )
    .unwrap()
}

// --- Frontmatter parsing -------------------------------------------------------------------

#[test]
fn render_then_parse_round_trips_the_spec() {
    let spec = MissionSpec {
        title: "Add OAuth login".into(),
        objective: "Ship one paragraph the coordinator decomposes.".into(),
        acceptance: vec!["npm test passes".into(), "manual flow works".into()],
        max_parallel: 3,
        max_rounds: 8,
        budget_usd_cap: 12.5,
        worktree_mode: "per-task".into(),
        coordinator: Some(CoordinatorSpec {
            provider: "opencode".into(),
            model: "gpt-5.2".into(),
            permission: "full_access".into(),
        }),
    };
    let doc = render_mission_doc(&spec, "# Body\n\nprose stays untouched\n");
    let parsed = parse_mission_doc(&doc).unwrap();
    assert_eq!(parsed.spec, spec);
    // The body below the fence is preserved verbatim in the rendered document.
    assert!(doc.contains("# Body"));
    assert!(doc.contains("prose stays untouched"));
}

#[test]
fn parse_accepts_quoted_scalars_and_multiline_coordinator_block() {
    let doc = "---\ntitle: \"Quoted \\\"Title\\\"\"\nobjective: plain\nacceptance:\n  - first\n  - \"second item\"\nmax_parallel: 2\nmax_rounds: 4\nbudget_usd_cap: 5\nworktree_mode: shared\ncoordinator:\n  provider: claude\n  model: sonnet\n---\n\nbody";
    let parsed = parse_mission_doc(doc).unwrap();
    assert_eq!(parsed.spec.title, "Quoted \"Title\"");
    assert_eq!(parsed.spec.acceptance, vec!["first", "second item"]);
    assert_eq!(parsed.spec.budget_usd_cap, 5.0);
    let coordinator = parsed.spec.coordinator.unwrap();
    assert_eq!(coordinator.provider, "claude");
    assert_eq!(coordinator.model, "sonnet");
}

#[test]
fn parse_rejects_unknown_keys_with_their_line_number() {
    let err =
        parse_mission_doc("---\ntitle: t\nobjective: o\nbogus_key: 1\n---\n").unwrap_err();
    assert!(
        err.contains("unknown frontmatter key 'bogus_key'"),
        "{}",
        err
    );
    assert!(err.contains("line 4"), "{}", err);
}

#[test]
fn parse_rejects_out_of_range_limits_and_bad_modes() {
    let cases = [
        ("max_parallel: 0", "max_parallel"),
        ("max_parallel: 9", "max_parallel"),
        ("max_rounds: 0", "max_rounds"),
        ("budget_usd_cap: 0", "budget_usd_cap"),
        ("worktree_mode: solo", "worktree_mode"),
        ("max_parallel: many", "whole number"),
    ];
    for (override_line, needle) in cases {
        let doc = format!("---\ntitle: t\nobjective: o\n{}\n---\n", override_line);
        let err = parse_mission_doc(&doc).unwrap_err();
        assert!(
            err.contains(needle),
            "'{}' should mention {}: got {}",
            override_line,
            needle,
            err
        );
    }
}

#[test]
fn parse_rejects_missing_fences_and_empty_required_fields() {
    assert!(parse_mission_doc("no frontmatter here").is_err());
    assert!(
        parse_mission_doc("---\ntitle: t\nobjective: o\n").is_err(),
        "missing close fence"
    );
    assert!(
        parse_mission_doc("---\nobjective: o\n---\n").is_err(),
        "missing title"
    );
    assert!(
        parse_mission_doc("---\ntitle: t\n---\n").is_err(),
        "missing objective"
    );
}

#[test]
fn parse_rejects_unknown_coordinator_entries() {
    let err = parse_mission_doc(
        "---\ntitle: t\nobjective: o\ncoordinator: { provider: x, sneaky: 1 }\n---\n",
    )
    .unwrap_err();
    assert!(err.contains("sneaky"), "{}", err);
}

#[test]
fn mission_id_validation_blocks_path_tricks() {
    assert!(validate_mission_id("msn_01JqZ9").is_ok());
    for bad in [
        "", "task_1", "msn_", "../etc", "msn_a/b", "msn_a b", "MSN_x",
    ] {
        assert!(
            validate_mission_id(bad).is_err(),
            "'{}' must be rejected",
            bad
        );
    }
}

// --- Create / read / list ------------------------------------------------------------------

#[test]
fn create_then_read_round_trips() {
    let p = TempProject::new();
    let summary = mission_create_inner(
        &p.project(),
        "Add OAuth login",
        "One paragraph objective",
        MissionOptions {
            acceptance: Some(vec!["npm test passes".to_string()]),
            max_parallel: Some(2),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(summary.title, "Add OAuth login");
    assert_eq!(summary.status, "draft");
    assert!(summary.id.starts_with("msn_"));

    match mission_read_inner(&p.project(), &summary.id).unwrap() {
        MissionReadResult::Loaded {
            state,
            doc,
            warnings,
        } => {
            assert_eq!(state.id, summary.id);
            assert_eq!(state.revision, 1);
            assert_eq!(state.spec.max_parallel, 2);
            assert_eq!(state.spec.acceptance, vec!["npm test passes"]);
            assert!(warnings.is_empty(), "plain load carries no warnings");
            // The rendered doc is hand-editable markdown with frontmatter.
            assert!(doc.starts_with("---\n"));
            assert!(doc.contains("title: \"Add OAuth login\""));
            assert!(p.mission_dir(&summary.id).join("artifacts").exists());
        }
        other => panic!("expected loaded, got {:?}", other),
    }
}

#[test]
fn generated_ids_use_the_documented_prefix_and_ulid_shape() {
    let p = TempProject::new();
    let mission = create_mission(&p, "IDs");
    assert!(mission.id.starts_with("msn_"));
    assert_eq!(mission.id.len(), 30);

    let state = mission_read_inner(&p.project(), &mission.id).unwrap();
    let MissionReadResult::Loaded { state, .. } = state else {
        panic!("expected loaded mission")
    };
    let tasks = mission_set_tasks_inner(
        &p.project(),
        &mission.id,
        state.revision,
        vec![TaskSpecInput {
            key: Some("one".to_string()),
            title: "One".to_string(),
            kind: "implement".to_string(),
            spec: String::new(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();
    assert!(tasks.tasks[0].id.starts_with("task_"));
    assert_eq!(tasks.tasks[0].id.len(), 31);
}

#[test]
fn read_reports_missing_for_unknown_ids() {
    let p = TempProject::new();
    assert!(matches!(
        mission_read_inner(&p.project(), "msn_doesnotexist").unwrap(),
        MissionReadResult::Missing
    ));
    assert!(!p.path.join(".saple").join("missions").exists());
}

#[test]
fn state_id_mismatch_is_corrupt_and_preserves_evidence() {
    let p = TempProject::new();
    let mission = create_mission(&p, "Identity");
    let state_path = p.mission_dir(&mission.id).join("state.json");
    let mut state: MissionState =
        serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
    state.id = "msn_other".to_string();
    fs::write(&state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();

    match mission_read_inner(&p.project(), &mission.id).unwrap() {
        MissionReadResult::Corrupt { error, backup_path } => {
            assert!(error.contains("does not match"), "{}", error);
            assert!(Path::new(&backup_path).exists());
        }
        other => panic!("expected corrupt identity, got {:?}", other),
    }
}

#[test]
fn list_returns_summaries_newest_first() {
    let p = TempProject::new();
    let first = create_mission(&p, "First");
    // now_iso has second resolution; age the first mission explicitly so ordering
    // is deterministic instead of same-second tie-break luck.
    let state_path = p.mission_dir(&first.id).join("state.json");
    let mut older: MissionState =
        serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
    older.updated_at = "2020-01-01T00:00:00Z".to_string();
    fs::write(&state_path, serde_json::to_vec_pretty(&older).unwrap()).unwrap();

    let second = create_mission(&p, "Second");

    let summaries = mission_list_inner(&p.project()).unwrap();
    assert_eq!(summaries.len(), 2);
    assert_eq!(summaries[0].id, second.id, "second was created later");
    assert_eq!(summaries[1].id, first.id);

    // A stray directory that does not look like a mission id is ignored.
    fs::create_dir_all(p.path.join(".saple").join("missions").join("not-a-mission")).unwrap();
    assert_eq!(mission_list_inner(&p.project()).unwrap().len(), 2);
}

#[test]
fn list_surfaces_a_doc_when_state_is_missing() {
    let p = TempProject::new();
    let mission = create_mission(&p, "Recover me");
    fs::remove_file(p.mission_dir(&mission.id).join("state.json")).unwrap();

    let summaries = mission_list_inner(&p.project()).unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, mission.id);
    assert_eq!(summaries[0].title, "Recover me");
    assert_eq!(summaries[0].status, "draft");
}

#[test]
fn mission_commands_require_the_workspace_flag() {
    let p = TempProject::new();
    assert!(ensure_missions_enabled(&p.project()).is_err());

    fs::write(
        p.path.join(".saple").join("config.json"),
        serde_json::json!({
            "workspaceId": "test",
            "workspaceName": "test",
            "memoryMode": "saple",
            "defaultProvider": "codex",
            "defaultModelByProvider": {},
            "maxParallelAgents": 12,
            "enableEditMode": true,
            "verificationPresets": [],
            "missionsEnabled": true,
            "createdAt": "now",
            "updatedAt": "now"
        })
        .to_string(),
    )
    .unwrap();
    assert!(ensure_missions_enabled(&p.project()).is_ok());
}

// --- Doc editing -----------------------------------------------------------------------------

#[test]
fn update_doc_validates_rewrites_spec_and_bumps_revision() {
    let p = TempProject::new();
    let m = create_mission(&p, "Before");

    let new_doc = "---\ntitle: After\nobjective: updated objective\nmax_parallel: 6\nmax_rounds: 3\nbudget_usd_cap: 9\nworktree_mode: per-mission\n---\n\nNew body prose.\n";
    let state = mission_update_doc_inner(&p.project(), &m.id, new_doc, 1).unwrap();

    assert_eq!(state.revision, 2);
    assert_eq!(state.spec.title, "After");
    assert_eq!(state.spec.max_parallel, 6);
    // Prose landed verbatim on disk.
    let on_disk = fs::read_to_string(p.mission_dir(&m.id).join("mission.md")).unwrap();
    assert!(on_disk.contains("New body prose."));
    // The event log records the edit.
    assert!(state.events.iter().any(|e| e.kind == "doc_updated"));

    // Stale revision refused.
    let err = mission_update_doc_inner(&p.project(), &m.id, new_doc, 1).unwrap_err();
    assert!(err.contains("Revision conflict"), "{}", err);

    // Invalid frontmatter refused without touching disk.
    let before = fs::read_to_string(p.mission_dir(&m.id).join("mission.md")).unwrap();
    let err =
        mission_update_doc_inner(&p.project(), &m.id, "---\nbogus: 1\n---\n", state.revision)
            .unwrap_err();
    assert!(err.contains("bogus"));
    assert_eq!(
        fs::read_to_string(p.mission_dir(&m.id).join("mission.md")).unwrap(),
        before
    );
}

#[test]
fn hand_edited_frontmatter_is_adopted_on_read() {
    let p = TempProject::new();
    let m = create_mission(&p, "Original");

    let doc_path = p.mission_dir(&m.id).join("mission.md");
    let edited = "---\ntitle: Hand Edited\nobjective: changed externally\nmax_parallel: 8\nmax_rounds: 12\nbudget_usd_cap: 15\nworktree_mode: shared\n---\n\nExternal prose.\n";
    fs::write(&doc_path, edited).unwrap();

    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded {
            state, warnings, ..
        } => {
            assert_eq!(state.spec.title, "Hand Edited");
            assert_eq!(state.spec.max_parallel, 8);
            assert_eq!(state.revision, 2, "adoption is an audited revision bump");
            assert!(warnings.is_empty());
            assert!(state.events.iter().any(|e| e.kind == "doc_reconciled"));
        }
        other => panic!("expected loaded, got {:?}", other),
    }
}

#[test]
fn list_reconciles_hand_edited_frontmatter() {
    let p = TempProject::new();
    let m = create_mission(&p, "Original");
    fs::write(
        p.mission_dir(&m.id).join("mission.md"),
        "---\ntitle: Renamed\nobjective: changed\n---\n\nbody\n",
    )
    .unwrap();

    let summaries = mission_list_inner(&p.project()).unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].title, "Renamed");
    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded { state, .. } => assert_eq!(state.revision, 2),
        other => panic!("expected loaded, got {:?}", other),
    }
}

#[test]
fn invalid_external_edit_falls_back_to_last_good_spec_with_warning() {
    let p = TempProject::new();
    let m = create_mission(&p, "Good Spec");

    // An agent typoed the frontmatter: unknown key AND out-of-range parallelism.
    fs::write(
        p.mission_dir(&m.id).join("mission.md"),
        "---\ntitle: Broken Edit\nobjective: o\nmax_parallel: 99\nwho_knows: 1\n---\n",
    )
    .unwrap();

    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded {
            state, warnings, ..
        } => {
            assert_eq!(state.spec.title, "Good Spec", "last-good spec kept");
            assert_eq!(state.revision, 1, "no adoption happened");
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("rejected"), "{}", warnings[0]);
        }
        other => panic!("expected loaded, got {:?}", other),
    }
}

#[test]
fn crash_between_writes_repairs_state_from_markdown_on_read() {
    let p = TempProject::new();
    let m = create_mission(&p, "Crash Survivor");
    // Simulate the kill between mission.md and state.json writes.
    fs::remove_file(p.mission_dir(&m.id).join("state.json")).unwrap();

    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded {
            state, warnings, ..
        } => {
            assert_eq!(state.spec.title, "Crash Survivor");
            assert!(
                warnings.iter().any(|w| w.contains("rebuilt")),
                "{:?}",
                warnings
            );
            // The repaired file persists and lists cleanly afterwards.
            assert!(p.mission_dir(&m.id).join("state.json").exists());
            assert!(mission_list_inner(&p.project())
                .unwrap()
                .iter()
                .any(|s| s.id == m.id && s.title == "Crash Survivor"));
        }
        other => panic!("expected repaired load, got {:?}", other),
    }
}

#[test]
fn corrupt_state_preserves_bytes_and_surfaces_recovery() {
    let p = TempProject::new();
    let m = create_mission(&p, "Corruptible");
    let state_path = p.mission_dir(&m.id).join("state.json");
    fs::write(&state_path, "{ not json").unwrap();

    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Corrupt { error, backup_path } => {
            assert!(error.contains("parse"), "{}", error);
            assert_eq!(fs::read_to_string(&backup_path).unwrap(), "{ not json");
        }
        other => panic!("expected corrupt, got {:?}", other),
    }
    // Mutations refuse to touch the evidence while flagged...
    let err = mission_set_tasks_inner(&p.project(), &m.id, 1, vec![]).unwrap_err();
    assert!(err.contains("parse"), "{}", err);
    assert_eq!(fs::read_to_string(&state_path).unwrap(), "{ not json");

    // ...until the file is repaired externally (a clean parse lifts the flag).
    let repaired = format!(
        r#"{{"id":"{id}","revision":1,"status":"draft","spec":{{"title":"Corruptible","objective":"Do the thing","acceptance":[],"maxParallel":4,"maxRounds":12,"budgetUsdCap":15,"worktreeMode":"shared"}},"tasks":[],"events":[],"idempotency":{{}},"createdAt":"t","updatedAt":"t"}}"#,
        id = m.id
    );
    fs::write(&state_path, repaired).unwrap();
    let state = mission_set_tasks_inner(&p.project(), &m.id, 1, vec![]).unwrap();
    assert_eq!(state.revision, 2);
}

// --- Task DAG --------------------------------------------------------------------------------

fn task_input(key: &str, deps: &[&str]) -> TaskSpecInput {
    TaskSpecInput {
        key: Some(key.to_string()),
        title: format!("Task {}", key),
        kind: "implement".to_string(),
        spec: format!("Instructions for {}", key),
        deps: deps.iter().map(|d| d.to_string()).collect(),
        fanout: 1,
        allow_stale_base: false,
    }
}

#[test]
fn dag_validator_catches_cycles_unknown_deps_and_self_deps() {
    let keys = |k: &[&str]| k.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let deps = |d: &[&[&str]]| -> Vec<Vec<String>> {
        d.iter()
            .map(|row| row.iter().map(|s| s.to_string()).collect::<Vec<_>>())
            .collect()
    };

    validate_task_dag(&keys(&["a", "b"]), &deps(&[&[], &["a"]])).unwrap();
    validate_task_dag(&keys(&["a"]), &deps(&[&[]])).unwrap();
    validate_task_dag(&keys(&[]), &deps(&[])).unwrap();

    // Direct + transitive cycles.
    let err = validate_task_dag(&keys(&["a", "b"]), &deps(&[&["b"], &["a"]])).unwrap_err();
    assert!(err.contains("cycle"), "{}", err);
    let err = validate_task_dag(
        &keys(&["root", "a", "b", "c"]),
        &deps(&[&[], &["root", "c"], &["a"], &["b"]]),
    )
    .unwrap_err();
    assert!(err.contains("cycle"), "{}", err);

    // Self-dep and unknown dep get their own messages.
    let err = validate_task_dag(&keys(&["a"]), &deps(&[&["a"]])).unwrap_err();
    assert!(err.contains("itself"), "{}", err);
    let err = validate_task_dag(&keys(&["a"]), &deps(&[&["ghost"]])).unwrap_err();
    assert!(err.contains("unknown task 'ghost'"), "{}", err);

    // Duplicate keys are rejected before any graph walk.
    let err = validate_task_dag(&keys(&["a", "a"]), &deps(&[&[], &[]])).unwrap_err();
    assert!(err.contains("duplicate task key"), "{}", err);
}

#[test]
fn set_tasks_computes_initial_statuses_and_mints_server_ids() {
    let p = TempProject::new();
    let m = create_mission(&p, "Dag Mission");

    let specs = vec![
        task_input("setup", &[]),
        task_input("fe", &["setup"]),
        task_input("be", &["setup"]),
        task_input("verify", &["fe", "be"]),
    ];
    let state = mission_set_tasks_inner(&p.project(), &m.id, 1, specs).unwrap();

    assert_eq!(state.tasks.len(), 4);
    assert_eq!(state.revision, 2);
    let by_title = |t: &str| {
        state
            .tasks
            .iter()
            .find(|x| x.title == format!("Task {}", t))
            .unwrap()
    };
    assert_eq!(by_title("setup").status, "ready");
    assert_eq!(by_title("fe").status, "pending");
    assert_eq!(by_title("be").status, "pending");
    assert_eq!(by_title("verify").status, "pending");
    // Deps were remapped from client keys to server-minted ids.
    let fe = by_title("fe");
    assert_eq!(fe.deps, vec![by_title("setup").id.clone()]);
    assert!(fe.id.starts_with("task_"));
    // All four ids are unique.
    let mut ids: Vec<_> = state.tasks.iter().map(|t| t.id.clone()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 4);
    assert!(state.events.iter().any(|e| e.kind == "tasks_set"));
}

#[test]
fn set_tasks_rejects_bad_graphs_without_writing() {
    let p = TempProject::new();
    let m = create_mission(&p, "Rejects");

    let cases: Vec<(Vec<TaskSpecInput>, &str)> = vec![
        (vec![task_input("a", &["ghost"])], "unknown task 'ghost'"),
        (vec![task_input("a", &["a"])], "depends on itself"),
        (
            vec![task_input("a", &["b"]), task_input("b", &["a"])],
            "cycle",
        ),
    ];
    for (specs, needle) in cases {
        let err = mission_set_tasks_inner(&p.project(), &m.id, 1, specs).unwrap_err();
        assert!(err.contains(needle), "expected '{}': got {}", needle, err);
    }

    // Kind + fanout validation.
    let mut bad_kind = task_input("a", &[]);
    bad_kind.kind = "deploy".to_string();
    assert!(
        mission_set_tasks_inner(&p.project(), &m.id, 1, vec![bad_kind])
            .unwrap_err()
            .contains("invalid kind")
    );
    let mut bad_fanout = task_input("a", &[]);
    bad_fanout.fanout = 4;
    assert!(
        mission_set_tasks_inner(&p.project(), &m.id, 1, vec![bad_fanout])
            .unwrap_err()
            .contains("fanout")
    );

    // Nothing above may have mutated the mission: still revision 1, no tasks.
    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded { state, .. } => {
            assert_eq!(state.revision, 1);
            assert!(state.tasks.is_empty());
        }
        other => panic!("expected loaded, got {:?}", other),
    }
}

// --- Commands: CAS, lifecycle, idempotency ----------------------------------------------------

#[test]
fn cas_conflict_refuses_stale_writes() {
    let p = TempProject::new();
    let m = create_mission(&p, "Cas");
    let err = mission_command_inner(&p.project(), &m.id, 999, "req_1", MissionCommand::Start)
        .unwrap_err();
    assert!(err.contains("Revision conflict"), "{}", err);
    // Nothing changed.
    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded { state, .. } => {
            assert_eq!(state.status, "draft");
            assert_eq!(state.revision, 1);
        }
        other => panic!("expected loaded, got {:?}", other),
    }
}

#[test]
fn lifecycle_transitions_follow_the_status_machine() {
    let p = TempProject::new();
    let m = create_mission(&p, "Lifecycle");

    let run = |rev, req: &str, cmd| {
        mission_command_inner(&p.project(), &m.id, rev, req, cmd).map(|s| s.status)
    };
    assert_eq!(run(1, "r1", MissionCommand::Start).unwrap(), "running");
    assert_eq!(run(2, "r2", MissionCommand::Pause).unwrap(), "paused");
    assert_eq!(run(3, "r3", MissionCommand::Resume).unwrap(), "running");
    assert_eq!(run(4, "r4", MissionCommand::Cancel).unwrap(), "cancelled");

    // Terminal states reject everything.
    let err = run(5, "r5", MissionCommand::Start).unwrap_err();
    assert!(err.contains("'cancelled'"), "{}", err);

    // Invalid transition from draft recorded as rejection, state unchanged.
    let m2 = create_mission(&p, "No Pause Yet");
    let err = mission_command_inner(&p.project(), &m2.id, 1, "bad", MissionCommand::Resume)
        .unwrap_err();
    assert!(err.contains("cannot resume"), "{}", err);
    match mission_read_inner(&p.project(), &m2.id).unwrap() {
        MissionReadResult::Loaded { state, .. } => {
            assert_eq!(state.status, "draft");
            assert_eq!(
                state.events.iter().filter(|e| e.kind == "resumed").count(),
                0
            );
        }
        other => panic!("expected loaded, got {:?}", other),
    }
}

#[test]
fn command_replay_is_idempotent_for_applied_and_rejected_requests() {
    let p = TempProject::new();
    let m = create_mission(&p, "Replay");

    // First application flips to running at revision 2.
    let applied =
        mission_command_inner(&p.project(), &m.id, 1, "req_start", MissionCommand::Start)
            .unwrap();
    assert_eq!(applied.status, "running");
    assert_eq!(applied.revision, 2);

    // A later transition changes the live state, but does not change the original result.
    let paused =
        mission_command_inner(&p.project(), &m.id, 2, "req_pause", MissionCommand::Pause)
            .unwrap();
    assert_eq!(paused.status, "paused");
    let replayed =
        mission_command_inner(&p.project(), &m.id, 1, "req_start", MissionCommand::Start)
            .unwrap();
    assert_eq!(replayed.status, "running");
    assert_eq!(replayed.revision, 2, "replay returns the original result");
    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded { state, .. } => {
            assert_eq!(state.revision, 3);
            assert_eq!(
                state.events.iter().filter(|e| e.kind == "started").count(),
                1
            );
        }
        other => panic!("expected loaded, got {:?}", other),
    }

    // A rejected request replays its recorded error on repeat attempts.
    let first_err = mission_command_inner(
        &p.project(),
        &m.id,
        3,
        "req_bad",
        MissionCommand::Retry {
            dispatch_id: "dsp_missing".to_string(),
        },
    )
    .unwrap_err();
    assert!(first_err.contains("unknown dispatch"), "{}", first_err);
    let replay_err = mission_command_inner(
        &p.project(),
        &m.id,
        3,
        "req_bad",
        MissionCommand::Retry {
            dispatch_id: "dsp_missing".to_string(),
        },
    )
    .unwrap_err();
    assert_eq!(first_err, replay_err);

    // A genuinely new request_id applies normally.
    let next =
        mission_command_inner(&p.project(), &m.id, 3, "req_cancel", MissionCommand::Cancel)
            .unwrap();
    assert_eq!(next.status, "cancelled");
}

#[test]
fn empty_request_id_is_rejected_before_any_locking() {
    let p = TempProject::new();
    let m = create_mission(&p, "ReqId");
    let err =
        mission_command_inner(&p.project(), &m.id, 1, "  ", MissionCommand::Start).unwrap_err();
    assert!(err.contains("request_id"), "{}", err);
}

// --- Event log --------------------------------------------------------------------------------

#[test]
fn event_overflow_archives_to_events_log() {
    let p = TempProject::new();
    let m = create_mission(&p, "Archive");
    let mut state = match load_state(&p.project(), &m.id).unwrap() {
        LoadedState::Ok(state) => state,
        _ => panic!("state must load"),
    };
    for n in 0..(EVENT_CAP + 20) {
        record_event(
            &p.project(),
            &m.id,
            &mut state,
            "tick",
            serde_json::json!({ "n": n }),
        )
        .unwrap();
    }
    assert_eq!(state.events.len(), EVENT_CAP);
    assert_eq!(state.events.first().unwrap().seq, 21, "oldest 20 archived");
    persist_state(&p.project(), &m.id, &state).unwrap();

    let log = fs::read_to_string(p.mission_dir(&m.id).join("events.log")).unwrap();
    assert_eq!(log.lines().count(), 20);
    assert!(log.lines().next().unwrap().contains("\"seq\":1"));
}

// --- Phase M2: Dispatching & Result Recording --------------------------------------------------

#[test]
fn manual_dispatch_creates_attempt_preamble_and_running_dispatch() {
    let p = TempProject::new();
    let m = create_mission(&p, "DispatchTest");
    let initial_state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![
            TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Write authentication service".to_string(),
                deps: Vec::new(),
                fanout: 1,
                allow_stale_base: false,
            },
            TaskSpecInput {
                key: Some("t2".to_string()),
                title: "Task 2".to_string(),
                kind: "verify".to_string(),
                spec: "Run auth tests".to_string(),
                deps: vec!["t1".to_string()],
                fanout: 1,
                allow_stale_base: false,
            },
        ],
    )
    .unwrap();

    let task1_id = initial_state.tasks[0].id.clone();
    let task2_id = initial_state.tasks[1].id.clone();
    assert_eq!(initial_state.tasks[0].status, "ready");
    assert_eq!(initial_state.tasks[1].status, "pending");

    let dispatch_output = mission_dispatch_task_inner(
        &p.project(),
        &m.id,
        &task1_id,
        "codex",
        Some("gpt-5.2".to_string()),
        2,
    )
    .unwrap();

    assert!(dispatch_output.dispatch_id.starts_with("dsp_"));
    assert!(dispatch_output.attempt_id.starts_with("att_"));
    assert!(dispatch_output.pane_id.starts_with("pane_"));
    assert!(!dispatch_output.capability_token.is_empty());

    let state = dispatch_output.state;
    assert_eq!(state.revision, 3);
    assert_eq!(state.tasks[0].status, "dispatched");
    assert_eq!(state.dispatches.len(), 1);

    let d = &state.dispatches[0];
    assert_eq!(d.id, dispatch_output.dispatch_id);
    assert_eq!(d.task_id, task1_id);
    assert_eq!(d.provider, "codex");
    assert_eq!(d.model, "gpt-5.2");
    assert_eq!(d.status, "starting");
    assert!(d.capability_hash.starts_with("sha256:"));

    // Check that prompt file was written to disk
    let prompt_path = p.path.join(&dispatch_output.prompt_file);
    assert!(prompt_path.exists());
    let prompt_body = fs::read_to_string(prompt_path).unwrap();
    assert!(prompt_body.contains("Write authentication service"));
    assert!(prompt_body.contains(&dispatch_output.dispatch_id));

    // Now settle dispatch 1 with codex result
    let fixture = include_str!("../../fixtures/codex_jsonl.jsonl");
    let settled_state = mission_record_dispatch_result_inner(
        &p.project(),
        &m.id,
        &dispatch_output.dispatch_id,
        fixture,
        Some("Auth service is done and tested.".to_string()),
        3,
    )
    .unwrap();

    assert_eq!(settled_state.revision, 4);
    assert_eq!(settled_state.dispatches[0].status, "succeeded");
    assert_eq!(settled_state.tasks[0].status, "completed");
    // Task 2 was promoted from pending to ready!
    assert_eq!(settled_state.tasks[1].status, "ready");
    assert_eq!(settled_state.tasks[1].id, task2_id);
}

#[test]
fn dispatch_rejects_ineligible_provider() {
    let p = TempProject::new();
    let m = create_mission(&p, "Ineligible");
    let initial_state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![TaskSpecInput {
            key: Some("t1".to_string()),
            title: "Task 1".to_string(),
            kind: "implement".to_string(),
            spec: "Do something".to_string(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();

    let task1_id = initial_state.tasks[0].id.clone();
    let err = mission_dispatch_task_inner(
        &p.project(),
        &m.id,
        &task1_id,
        "cursor",
        None,
        2,
    )
    .unwrap_err();

    assert!(err.contains("not eligible"), "{}", err);
}

#[test]
fn dispatch_revision_conflict_fails_cleanly() {
    let p = TempProject::new();
    let m = create_mission(&p, "Conflict");
    let initial_state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![TaskSpecInput {
            key: Some("t1".to_string()),
            title: "Task 1".to_string(),
            kind: "implement".to_string(),
            spec: "Do something".to_string(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();

    let task1_id = initial_state.tasks[0].id.clone();
    let err = mission_dispatch_task_inner(
        &p.project(),
        &m.id,
        &task1_id,
        "claude",
        None,
        999, // wrong revision
    )
    .unwrap_err();

    assert!(err.contains("Revision conflict"), "{}", err);
}

// --- Phase M3: Scheduler, Supervisor, Pooling, and Recovery Tests -------------------------------

#[test]
fn scheduler_tick_promotes_waves_and_completes_mission() {
    let p = TempProject::new();
    let m = create_mission(&p, "WaveTest");

    // Start mission
    let started = mission_command_inner(&p.project(), &m.id, 1, "start_1", MissionCommand::Start).unwrap();
    assert_eq!(started.status, "running");

    // Set DAG: T1 -> T2
    let state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        2,
        vec![
            TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Step 1".to_string(),
                deps: Vec::new(),
                fanout: 1,
                allow_stale_base: false,
            },
            TaskSpecInput {
                key: Some("t2".to_string()),
                title: "Task 2".to_string(),
                kind: "verify".to_string(),
                spec: "Step 2".to_string(),
                deps: vec!["t1".to_string()],
                fanout: 1,
                allow_stale_base: false,
            },
        ],
    )
    .unwrap();

    let t1_id = state.tasks[0].id.clone();
    let t2_id = state.tasks[1].id.clone();

    // Dispatch T1
    let dsp1 = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 3).unwrap();
    assert_eq!(dsp1.state.tasks[0].status, "dispatched");

    // Settle T1
    let fixture = include_str!("../../fixtures/codex_jsonl.jsonl");
    let settled1 = mission_record_dispatch_result_inner(
        &p.project(),
        &m.id,
        &dsp1.dispatch_id,
        fixture,
        Some("Step 1 done".to_string()),
        4,
    )
    .unwrap();

    assert_eq!(settled1.tasks[0].status, "completed");
    assert_eq!(settled1.tasks[1].status, "ready");
    // Session was pooled
    assert_eq!(settled1.pool.len(), 1);
    assert_eq!(settled1.pool[0].state, "idle");

    // Dispatch T2 with session reuse!
    let dsp2 = mission_dispatch_task_inner(&p.project(), &m.id, &t2_id, "codex", None, 5).unwrap();
    assert_eq!(dsp2.state.pool[0].state, "retained");
    assert_eq!(dsp2.state.pool[0].reused_count, 1);

    // Settle T2 -> mission automatically completes!
    let settled2 = mission_record_dispatch_result_inner(
        &p.project(),
        &m.id,
        &dsp2.dispatch_id,
        fixture,
        Some("Step 2 verified".to_string()),
        6,
    )
    .unwrap();

    assert_eq!(settled2.status, "completed");
    assert_eq!(settled2.tasks[1].status, "completed");
    assert_eq!(settled2.pool[0].state, "released");
}

#[test]
fn retry_and_abandon_commands_behave_correctly() {
    let p = TempProject::new();
    let m = create_mission(&p, "RetryAbandonTest");

    let state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![TaskSpecInput {
            key: Some("t1".to_string()),
            title: "Task 1".to_string(),
            kind: "implement".to_string(),
            spec: "Do something".to_string(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();

    let t1_id = state.tasks[0].id.clone();
    let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

    // Abandon command
    let abandoned = mission_command_inner(
        &p.project(),
        &m.id,
        3,
        "req_abandon",
        MissionCommand::Abandon {
            dispatch_id: dsp.dispatch_id.clone(),
        },
    )
    .unwrap();

    assert_eq!(abandoned.dispatches[0].status, "abandoned");
    assert_eq!(abandoned.tasks[0].status, "failed");

    // Retry command resets task to ready
    let retried = mission_command_inner(
        &p.project(),
        &m.id,
        4,
        "req_retry",
        MissionCommand::Retry {
            dispatch_id: dsp.dispatch_id,
        },
    )
    .unwrap();

    assert_eq!(retried.tasks[0].status, "ready");
}

#[test]
fn recovery_scans_and_updates_orphan_dispatches() {
    let p = TempProject::new();
    let m = create_mission(&p, "RecoveryTest");

    let state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![TaskSpecInput {
            key: Some("t1".to_string()),
            title: "Task 1".to_string(),
            kind: "implement".to_string(),
            spec: "Do something".to_string(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();

    let t1_id = state.tasks[0].id.clone();
    let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();
    assert_eq!(dsp.state.dispatches[0].status, "starting");

    // Recover without live panes -> starting dispatch becomes starting_unknown
    let live_panes = std::collections::HashSet::new();
    let summaries = mission_recover_inner(&p.project(), &live_panes).unwrap();
    assert_eq!(summaries.len(), 1);

    // Read mission state to verify honest unknown state
    match mission_read_inner(&p.project(), &m.id).unwrap() {
        MissionReadResult::Loaded { state, .. } => {
            assert_eq!(state.dispatches[0].status, "starting_unknown");
            assert_eq!(state.tasks[0].status, "failed");
        }
        other => panic!("expected loaded mission, got {:?}", other),
    }
}

#[test]
fn step_report_settles_and_promotes_dependents_transactionally() {
    let p = TempProject::new();
    let m = create_mission(&p, "SettlementTest");

    let state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![
            TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Do something".to_string(),
                deps: Vec::new(),
                fanout: 1,
                allow_stale_base: false,
            },
            TaskSpecInput {
                key: Some("t2".to_string()),
                title: "Task 2".to_string(),
                kind: "implement".to_string(),
                spec: "Do second thing".to_string(),
                deps: vec!["t1".to_string()],
                fanout: 1,
                allow_stale_base: false,
            },
        ],
    )
    .unwrap();

    let t1_id = state.tasks[0].id.clone();
    let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

    // 1. Submit step report done with correct token
    let report = settlement::StepReport {
        dispatch_id: dsp.dispatch_id.clone(),
        attempt_id: dsp.attempt_id.clone(),
        token: dsp.capability_token.clone(),
        pane_id: Some(dsp.pane_id.clone()),
        status: "done".to_string(),
        summary: "Task 1 implemented successfully".to_string(),
        changed_files: Some(vec!["src/main.rs".to_string()]),
        tests: Some(vec!["cargo test".to_string()]),
    };

    let outcome = mission_settle_report_inner(&p.project(), &m.id, report, 3).unwrap();
    assert_eq!(
        outcome.result,
        settlement::SettlementResult::Settled {
            task_id: t1_id,
            status: "succeeded".to_string(),
        }
    );
    assert_eq!(outcome.state.tasks[0].status, "completed");
    // Dependent task 2 is promoted!
    assert_eq!(outcome.state.tasks[1].status, "ready");
}

#[test]
fn worker_gate_request_and_resolution_flow() {
    let p = TempProject::new();
    let m = create_mission(&p, "GateTest");

    let state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![TaskSpecInput {
            key: Some("t1".to_string()),
            title: "Database Migration".to_string(),
            kind: "implement".to_string(),
            spec: "Run schema migration".to_string(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();

    let t1_id = state.tasks[0].id.clone();
    let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

    // 1. Worker requests decision gate
    let gated_state = mission_request_gate_inner(
        &p.project(),
        &m.id,
        gates::GateRequestInput {
            dispatch_id: dsp.dispatch_id.clone(),
            question: "Approve dropping legacy column?".to_string(),
            options: vec!["approve".to_string(), "reject".to_string()],
        },
        3,
    )
    .unwrap();

    assert_eq!(gated_state.tasks[0].status, "blocked");
    assert_eq!(gated_state.gates.len(), 1);
    let gate_id = gated_state.gates[0].id.clone();

    // 2. Human resolves gate
    let resolved_state = mission_resolve_gate_inner(
        &p.project(),
        &m.id,
        &gate_id,
        "approve",
        4,
    )
    .unwrap();

    assert_eq!(resolved_state.gates[0].status, "resolved");
    assert_eq!(resolved_state.gates[0].resolution, Some("approve".to_string()));
    assert_eq!(resolved_state.tasks[0].status, "ready");
}

#[test]
fn mailbox_and_ask_reply_end_to_end() {
    let p = TempProject::new();
    let m = create_mission(&p, "MailboxTest");

    let state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![TaskSpecInput {
            key: Some("t1".to_string()),
            title: "Task 1".to_string(),
            kind: "implement".to_string(),
            spec: "Do something".to_string(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();

    let t1_id = state.tasks[0].id.clone();
    let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

    // 1. Worker asks question
    let ask_res = mission_ask_inner(
        &p.project(),
        &m.id,
        ask_reply::AskInput {
            dispatch_id: dsp.dispatch_id.clone(),
            attempt_id: dsp.attempt_id.clone(),
            token: dsp.capability_token.clone(),
            pane_id: Some(dsp.pane_id.clone()),
            question: "Which database port?".to_string(),
            options: None,
            timeout_ms: None,
        },
        3,
    )
    .unwrap();

    assert_eq!(ask_res.state.messages.len(), 1);
    assert!(ask_res.state.messages[0].expects_reply);

    // 2. Operator replies
    let replied_state = mission_reply_inner(
        &p.project(),
        &m.id,
        &ask_res.output.thread_id,
        "Use port 5432",
        4,
    )
    .unwrap();

    assert_eq!(replied_state.messages.len(), 2);
    assert_eq!(replied_state.messages[0].answered_by, Some(replied_state.messages[1].id.clone()));

    // 3. Worker fetches inbox
    let inbox = mission_inbox_fetch_inner(&p.project(), &m.id, &format!("task_{}", t1_id)).unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].body, "Use port 5432");

    // 4. Worker acks inbox
    let acked_state = mission_inbox_ack_inner(&p.project(), &m.id, vec![inbox[0].id.clone()], 5).unwrap();
    assert!(acked_state.messages[1].acked);
}

#[test]
fn artifact_publishing_writes_to_disk_and_logs_event() {
    let p = TempProject::new();
    let m = create_mission(&p, "ArtifactTest");

    let state = mission_set_tasks_inner(
        &p.project(),
        &m.id,
        1,
        vec![TaskSpecInput {
            key: Some("t1".to_string()),
            title: "Task 1".to_string(),
            kind: "implement".to_string(),
            spec: "Do something".to_string(),
            deps: Vec::new(),
            fanout: 1,
            allow_stale_base: false,
        }],
    )
    .unwrap();

    let t1_id = state.tasks[0].id.clone();
    let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

    let published = mission_publish_artifact_inner(
        &p.project(),
        &m.id,
        ArtifactPublishInput {
            dispatch_id: dsp.dispatch_id,
            kind: "report".to_string(),
            content: "# Final Architecture\n\nDetailed breakdown of components.".to_string(),
            label: "Architecture Summary".to_string(),
        },
        3,
    )
    .unwrap();

    assert!(published.events.iter().any(|e| e.kind == "artifact_published"));
    let artifact_file = p.path.join(".saple/missions").join(&m.id).join("artifacts/architecture-summary/index.md");
    assert!(artifact_file.exists());
    assert!(fs::read_to_string(&artifact_file).unwrap().contains("Detailed breakdown"));
}
