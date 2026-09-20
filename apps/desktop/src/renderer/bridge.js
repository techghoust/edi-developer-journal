(function installProjectMemoryBridge() {
  if (window.journal) return;

  const invoke = window.__TAURI__?.core?.invoke;
  const convertFileSrc = window.__TAURI__?.core?.convertFileSrc;
  if (!invoke) {
    throw new Error('EDI Developer Journal native bridge is unavailable.');
  }

  window.journal = {
    listProjects: () => invoke('list_projects'),
    autoRelocateProjects: () => invoke('auto_relocate_projects'),
    getProject: (projectId) => invoke('get_project', { projectId }),
    updateProjectName: (input) => invoke('update_project_name', { input }),
    deleteProject: (projectId) => invoke('delete_project', { projectId }),
    createProject: (input) => invoke('create_project', { input }),
    openProjectPath: (input) => invoke('open_project_path', { input }),
    relocateProject: (input) => invoke('relocate_project', { input }),
    chooseProjectPath: () => invoke('choose_project_path'),
    chooseMediaFile: (mediaType) => invoke('choose_media_file', { mediaType }),
    openMediaLocation: (location) => invoke('open_media_location', { location }),
    getDataDirectory: () => invoke('get_data_directory'),
    exportProjectData: (projectId) => invoke('export_project_data', { projectId }),
    importProjectData: (projectId) => invoke('import_project_data', { projectId }),
    mediaUrl: (location) => /^(https?:|data:|blob:)/i.test(location)
      ? location
      : convertFileSrc
        ? convertFileSrc(location)
        : location,
    listEntries: (projectId) => invoke('list_entries', { projectId }),
    createEntry: (input) => invoke('create_entry', { input }),
    updateEntry: (input) => invoke('update_entry', { input }),
    deleteEntry: (entryId) => invoke('delete_entry', { entryId }),
    listCheckpoints: (projectId) => invoke('list_checkpoints', { projectId }),
    createCheckpoint: (input) => invoke('create_checkpoint', { input }),
    deleteCheckpoint: (checkpointId) => invoke('delete_checkpoint', { checkpointId }),
    listDecisions: (projectId) => invoke('list_decisions', { projectId }),
    createDecision: (input) => invoke('create_decision', { input }),
    updateDecision: (input) => invoke('update_decision', { input }),
    deleteDecision: (decisionId) => invoke('delete_decision', { decisionId }),
    listAssumptions: (projectId) => invoke('list_assumptions', { projectId }),
    createAssumption: (input) => invoke('create_assumption', { input }),
    updateAssumption: (input) => invoke('update_assumption', { input }),
    listExperiments: (projectId) => invoke('list_experiments', { projectId }),
    createExperiment: (input) => invoke('create_experiment', { input }),
    updateExperiment: (input) => invoke('update_experiment', { input }),
    deleteExperiment: (experimentId) => invoke('delete_experiment', { experimentId }),
    getEdiInsights: (projectId) => invoke('get_edi_insights', { projectId }),
    getWhyContext: (projectId, kind, memoryId) => invoke('get_why_context', { projectId, kind, memoryId }),
    getResumeContext: (projectId) => invoke('get_resume_context', { projectId }),
    listMemoryTimeline: (projectId) => invoke('list_memory_timeline', { projectId }),
    listResearch: (projectId) => invoke('list_research', { projectId }),
    createResearchItem: (input) => invoke('create_research_item', { input }),
    deleteResearchItem: (researchId) => invoke('delete_research_item', { researchId }),
    refreshGitMetadata: (input) => invoke('refresh_git_metadata', { input }),
    getCommits: (projectId) => invoke('get_commits', { projectId }),
    analyzeProjectXray: (projectId) => invoke('analyze_project_xray', { projectId }),
    simulateXrayRemoval: (projectId, dependencyId) => invoke('simulate_xray_removal', { projectId, dependencyId }),
    setXrayMemoryLinks: (input) => invoke('set_xray_memory_links', { input }),
    getAppStatus: () => invoke('get_app_status'),
  };
})();
