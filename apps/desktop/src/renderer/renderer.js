const layer = document.getElementById('windows-layer');
let activeProjectId = null;

function makeLine(num, text, cls = '') {
  const row = document.createElement('div');
  row.className = 'txt-line' + (cls ? ' ' + cls : '');
  const ln = document.createElement('span');
  ln.className = 'ln';
  ln.textContent = num !== null ? String(num) : '';
  const lc = document.createElement('span');
  lc.className = 'lc';
  lc.textContent = text;
  row.appendChild(ln);
  row.appendChild(lc);
  return row;
}

function makeInteractiveLine(row, action) {
  row.classList.add('memory-link');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    action();
  });
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  });
  return row;
}

function keepVisualLineNumbers(win, linesBox) {
  const update = () => {
    let nextNumber = 1;
    for (const row of linesBox.querySelectorAll(':scope > .txt-line')) {
      const numberCell = row.querySelector(':scope > .ln');
      const contentCell = row.querySelector(':scope > .lc');
      if (!numberCell || !contentCell || row.classList.contains('center')) continue;

      const lineHeight = Number.parseFloat(window.getComputedStyle(row).lineHeight);
      const contentHeight = contentCell.getBoundingClientRect().height;
      const visualLineCount = Number.isFinite(lineHeight) && lineHeight > 0
        ? Math.max(1, Math.round(contentHeight / lineHeight))
        : 1;

      numberCell.textContent = Array.from(
        { length: visualLineCount },
        () => String(nextNumber++),
      ).join('\n');
    }
  };

  win.lineNumberObserver?.disconnect();
  win.lineNumberObserver = new ResizeObserver(() => window.requestAnimationFrame(update));
  win.lineNumberObserver.observe(linesBox);
  window.requestAnimationFrame(update);
}

function formatDate(iso) {
  return iso.replace('T', ' ').slice(0, 16);
}

function mediaTypeForLocation(location, fallback = 'link') {
  const clean = String(location ?? '').split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(clean)) return 'image';
  if (/\.(mp4|webm|mov|mkv|avi)$/.test(clean)) return 'video';
  if (/\.pdf$/.test(clean)) return 'pdf';
  return fallback;
}

function mediaFileName(location) {
  return String(location ?? '').split(/[\\/]/).pop()?.split(/[?#]/)[0] ?? '';
}

function openImageViewer(location) {
  const winId = `image-viewer:${location}`;
  const existing = getDJWindow(winId);
  if (existing) {
    existing.bringToFront();
    return;
  }

  const width = Math.min(820, window.innerWidth - 64);
  const height = Math.min(650, window.innerHeight - 64);
  const viewer = new DJWindow({
    id: winId,
    title: mediaFileName(location) || 'IMAGE',
    x: Math.max(24, (window.innerWidth - width) / 2),
    y: Math.max(24, (window.innerHeight - height) / 2),
    width,
    height,
  });
  viewer.mount(layer);
  viewer.el.classList.add('image-viewer-window');

  const content = document.createElement('div');
  content.className = 'image-viewer-content';
  const image = document.createElement('img');
  image.className = 'image-viewer-image';
  image.alt = mediaFileName(location) || 'research image';
  image.src = window.journal.mediaUrl(location);
  content.appendChild(image);
  viewer.setContent(content);
}

function createMediaPreview(type, location, compact = false) {
  const preview = document.createElement('div');
  preview.className = `media-preview${compact ? ' compact' : ''}`;
  if (!location) {
    preview.classList.add('empty');
    return preview;
  }

  const detectedType = mediaTypeForLocation(location, type);
  let source = location;
  try { source = window.journal.mediaUrl(location); } catch {}
  const status = document.createElement('div');
  status.className = 'media-preview-status dim';
  const showUnavailable = (message = 'preview unavailable. open the original file or link.') => {
    status.textContent = message;
    if (!status.isConnected) preview.prepend(status);
  };

  if (detectedType === 'image' || type === 'link') {
    const image = document.createElement('img');
    image.className = 'media-image';
    image.alt = mediaFileName(location) || 'research image';
    image.addEventListener('load', () => status.remove());
    image.addEventListener('error', () => {
      image.remove();
      showUnavailable(type === 'link' ? 'web link saved. this address is not a direct image.' : undefined);
    });
    image.title = 'click to view full size';
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.addEventListener('click', () => openImageViewer(location));
    image.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openImageViewer(location);
    });
    status.textContent = 'loading preview…';
    preview.appendChild(status);
    preview.appendChild(image);
    image.src = source;
  } else if (detectedType === 'video') {
    const video = document.createElement('video');
    video.className = 'media-video';
    video.controls = true;
    video.preload = 'metadata';
    video.src = source;
    video.addEventListener('error', () => showUnavailable());
    preview.appendChild(video);
  } else if (detectedType === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'media-pdf';
    frame.title = mediaFileName(location) || 'research PDF';
    frame.src = source;
    preview.appendChild(frame);
  } else {
    showUnavailable('web link saved.');
  }

  const footer = document.createElement('div');
  footer.className = 'media-preview-footer';
  const locationText = document.createElement('span');
  locationText.className = 'media-preview-location';
  locationText.textContent = location;
  locationText.title = location;
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'button-secondary media-open-button';
  openButton.textContent = 'open';
  openButton.addEventListener('click', async () => {
    try { await window.journal.openMediaLocation(location); }
    catch (error) { showUnavailable(`failed to open: ${error?.message ?? error}`); }
  });
  footer.appendChild(locationText);
  footer.appendChild(openButton);
  preview.appendChild(footer);
  return preview;
}

function buildProjectsWindow() {
  const win = new DJWindow({
    id: 'projects',
    title: 'EDI Developer Journal',
    dockable: true,
    dockLabel: 'projects',
    x: 40,
    y: 40,
    width: 360,
    height: 520,
  });
  win.mount(layer);
  renderProjectsContent(win);
  return win;
}

async function renderProjectSettingsContent(settingsWin, projectsWin, selectedId = null) {
  const projects = await window.journal.listProjects();
  if (projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dim';
    empty.textContent = 'no saved projects.';
    settingsWin.setContent(empty);
    return;
  }

  const content = document.createElement('div');
  content.className = 'dj-form project-settings-content';
  content.innerHTML = `
    <section class="settings-section">
      <div class="settings-heading">[ PROJECT NAME ]</div>
      <div class="dj-row"><input class="settings-name" type="text" /><button class="button-secondary save-project-name" type="button">save</button></div>
    </section>
    <section class="settings-section">
      <div class="settings-heading">[ PROJECT PATH / REPOSITORY ]</div>
      <div class="dj-row"><input class="settings-path" type="text" /><button class="button-secondary browse-project-path" type="button">browse</button></div>
      <button class="button-secondary save-project-path" type="button">update repository</button>
    </section>
    <section class="settings-section">
      <div class="settings-heading">[ EXPORT / IMPORT ]</div>
      <div class="dj-row"><button class="button-secondary export-project-data" type="button">export JSON</button><button class="button-secondary import-project-data" type="button">import JSON</button></div>
    </section>
    <section class="settings-section">
      <div class="settings-heading">[ GIT INTEGRATION ]</div>
      <div class="settings-git"></div>
      <button class="button-secondary refresh-project-git" type="button">refresh git</button>
    </section>
    <section class="settings-section settings-danger-zone">
      <div class="settings-heading">[ DELETE PROJECT ]</div>
      <select class="delete-project-select" aria-label="project to delete"></select>
      <div class="dim">removes journal memory; repository files stay on disk.</div>
      <button class="button-danger delete-project-button" type="button">delete selected project</button>
    </section>
    <div class="dj-status"></div>
  `;
  const nameInput = content.querySelector('.settings-name');
  const pathInput = content.querySelector('.settings-path');
  const gitInfo = content.querySelector('.settings-git');
  const deleteProjectSelect = content.querySelector('.delete-project-select');
  const status = content.querySelector('.dj-status');
  const preferredId = selectedId || activeProjectId;
  const project = projects.find((item) => item.id === preferredId) ?? projects[0];
  const selectedProject = () => project;
  for (const item of projects) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    deleteProjectSelect.appendChild(option);
  }
  deleteProjectSelect.value = project.id;
  const selectedDeleteProject = () => projects.find((item) => item.id === deleteProjectSelect.value);
  const syncFields = () => {
    const project = selectedProject();
    if (!project) return;
    nameInput.value = project.name;
    pathInput.value = project.path;
    gitInfo.innerHTML = '';
    for (const [label, value] of [
      ['remote', project.gitRemote || 'none'],
      ['HEAD', project.lastHeadHash ? project.lastHeadHash.slice(0, 12) : 'unknown'],
      ['status', project.gitStatus || 'unknown'],
      ['last checked', project.lastCheckedAt ? formatDate(project.lastCheckedAt) : 'never'],
    ]) gitInfo.appendChild(makeLine(null, `${label}: ${value}`, value === 'unknown' ? 'dim' : ''));
  };
  syncFields();

  const refreshProjectUi = async (project) => {
    await renderProjectsContent(projectsWin);
    const projectWin = getDJWindow(`project:${project.id}`);
    if (projectWin) {
      projectWin.title = slugTitle(project.name);
      projectWin.el.querySelector('.dj-title').textContent = projectWin.title;
      await renderProjectWindowContent(projectWin, project);
    }
  };

  content.querySelector('.save-project-name').addEventListener('click', async () => {
    const project = selectedProject();
    if (!project) return;
    const name = nameInput.value.trim();
    if (!name) { status.textContent = 'project name is required.'; return; }
    try {
      const updated = await window.journal.updateProjectName({ projectId: project.id, name });
      await refreshProjectUi(updated);
      Object.assign(project, updated);
      syncFields();
      status.textContent = 'project name saved.';
    } catch (error) { status.textContent = `failed to update name: ${error?.message ?? error}`; }
  });

  content.querySelector('.browse-project-path').addEventListener('click', async () => {
    const selected = await window.journal.chooseProjectPath();
    if (selected) pathInput.value = selected;
  });

  content.querySelector('.save-project-path').addEventListener('click', async () => {
    const project = selectedProject();
    if (!project) return;
    try {
      const updated = await window.journal.relocateProject({ projectId: project.id, path: pathInput.value.trim() });
      await refreshProjectUi(updated);
      Object.assign(project, updated);
      syncFields();
      status.textContent = 'repository path updated.';
    } catch (error) { status.textContent = `failed to update path: ${error?.message ?? error}`; }
  });

  content.querySelector('.export-project-data').addEventListener('click', async () => {
    const project = selectedProject();
    if (!project) return;
    try {
      const exported = await window.journal.exportProjectData(project.id);
      status.textContent = exported ? `data exported: ${exported}` : '';
    } catch (error) { status.textContent = `export failed: ${error?.message ?? error}`; }
  });

  content.querySelector('.import-project-data').addEventListener('click', async () => {
    const project = selectedProject();
    if (!project) return;
    try {
      const imported = await window.journal.importProjectData(project.id);
      if (!imported) return;
      await refreshProjectUi(project);
      status.textContent = imported.imported > 0
        ? `imported ${imported.imported} memory items.`
        : 'nothing new to import.';
    } catch (error) { status.textContent = `import failed: ${error?.message ?? error}`; }
  });

  content.querySelector('.refresh-project-git').addEventListener('click', async () => {
    const project = selectedProject();
    if (!project) return;
    status.textContent = 'refreshing git…';
    try {
      await window.journal.refreshGitMetadata({ projectId: project.id });
      const updated = await window.journal.getProject(project.id);
      if (updated) await refreshProjectUi(updated);
      if (updated) Object.assign(project, updated);
      syncFields();
      status.textContent = 'git refreshed.';
    } catch (error) { status.textContent = `git refresh failed: ${error?.message ?? error}`; }
  });
  content.querySelector('.delete-project-button').addEventListener('click', async () => {
    const projectToDelete = selectedDeleteProject();
    if (!projectToDelete) return;
    if (!window.confirm(`delete project “${projectToDelete.name}” from EDI Developer Journal?\n\nPath: ${projectToDelete.path}\n\nThe project folder and its code will stay on disk.`)) return;
    try {
      await window.journal.deleteProject(projectToDelete.id);
      getDJWindow(`project:${projectToDelete.id}`)?.destroy();
      if (activeProjectId === projectToDelete.id) activeProjectId = null;
      await renderProjectsContent(projectsWin);
      const remaining = await window.journal.listProjects();
      if (remaining.length === 0) settingsWin.destroy();
      else {
        const current = selectedProject();
        const nextId = current.id === projectToDelete.id || !remaining.some((item) => item.id === current.id)
          ? remaining[0].id
          : current.id;
        await renderProjectSettingsContent(settingsWin, projectsWin, nextId);
      }
    } catch (error) {
      status.style.color = '#f88';
      status.textContent = `failed to delete project: ${error?.message ?? error}`;
    }
  });
  settingsWin.setContent(content);
}

async function openProjectSettingsWindow(projectsWin) {
  const existing = getDJWindow('project-settings');
  if (existing) {
    await renderProjectSettingsContent(existing, projectsWin);
    existing.bringToFront();
    return;
  }
  const width = 440;
  const height = Math.min(620, window.innerHeight - 72);
  const settingsWin = new DJWindow({
    id: 'project-settings',
    title: 'SETTINGS',
    x: Math.max(24, window.innerWidth - width - 48),
    y: Math.max(48, window.innerHeight - height - 58),
    width,
    height,
  });
  settingsWin.mount(layer);
  settingsWin.el.classList.add('settings-window');
  await renderProjectSettingsContent(settingsWin, projectsWin);
}

async function renderProjectsContent(win) {
  const container = document.createElement('div');
  container.className = 'projects-content';

  const statusBanner = document.createElement('div');
  statusBanner.className = 'dj-status';
  statusBanner.style.marginBottom = '8px';
  statusBanner.style.color = '#f88';
  container.appendChild(statusBanner);

  const linesBox = document.createElement('div');
  linesBox.className = 'txt-lines';
  container.appendChild(linesBox);

  const appStatus = await window.journal.getAppStatus();
  if (!appStatus.dbReady) {
    statusBanner.textContent = `database unavailable: ${appStatus.dbError ?? 'unknown error'}. the app will run in degraded mode.`;
  }

  let projects = [];
  try {
    const relocated = await window.journal.autoRelocateProjects();
    projects = await window.journal.listProjects();
    if (relocated.length > 0) {
      statusBanner.style.color = '#8f8';
      statusBanner.textContent = relocated.length === 1
        ? `found moved project “${relocated[0].name}”. path updated automatically.`
        : `found ${relocated.length} moved projects. paths updated automatically.`;
    }
  } catch (error) {
    statusBanner.textContent = `failed to load projects: ${error?.message ?? error}`;
    statusBanner.style.color = '#f88';
    statusBanner.style.whiteSpace = 'pre-wrap';
  }

  linesBox.appendChild(makeLine(null, '[ RECENT PROJECTS ]', 'accent center section-heading'));
  linesBox.appendChild(makeLine(null, 'Git remembers code. EDI Developer Journal remembers thought.', 'dim center'));

  if (projects.length === 0) {
    linesBox.appendChild(makeLine(null, 'no projects yet, create your first project below', 'dim'));
  } else {
    const list = document.createElement('div');
    list.style.marginTop = '4px';
    for (const project of projects) {
      const row = document.createElement('div');
      row.className = `project-row${project.pathExists === false ? ' path-missing' : ''}`;
      const heading = document.createElement('div');
      heading.className = 'project-row-heading';
      heading.innerHTML = `<span class="p-name">${escapeHtml(project.name)}</span>`;
      row.appendChild(heading);
      const projectPath = document.createElement('span');
      projectPath.className = 'p-path';
      projectPath.textContent = project.path;
      row.appendChild(projectPath);
      if (project.pathExists === false) {
        const missing = document.createElement('span');
        missing.className = 'p-missing';
        missing.textContent = 'folder moved or unavailable';
        const relocate = document.createElement('button');
        relocate.type = 'button';
        relocate.className = 'button-secondary button-inline relocate-project';
        relocate.textContent = 'relocate';
        relocate.addEventListener('click', async (event) => {
          event.stopPropagation();
          const selected = await window.journal.chooseProjectPath();
          if (!selected) return;
          try {
            const relocated = await window.journal.relocateProject({ projectId: project.id, path: selected });
            status.style.color = '#8f8';
            status.textContent = `project “${relocated.name}” relocated.`;
            await renderProjectsContent(win);
            openProjectWindow(relocated);
          } catch (error) {
            status.style.color = '#f88';
            status.textContent = `failed to relocate project: ${error?.message ?? error}`;
          }
        });
        heading.appendChild(relocate);
        row.appendChild(missing);
      }
      row.addEventListener('click', () => {
        status.textContent = '';
        if (project.pathExists === false) {
          status.style.color = '#f0b75a';
          status.textContent = 'project folder is unavailable. use relocate to choose its new location.';
          return;
        }
        openProjectWindow(project);
      });
      list.appendChild(row);
    }
    container.appendChild(list);
  }

  const sectionDivider = document.createElement('div');
  sectionDivider.className = 'section-divider';
  container.appendChild(sectionDivider);

  const newSectionTitle = makeLine(null, '[ NEW PROJECT ]', 'accent center new-project-heading');
  container.appendChild(newSectionTitle);

  const form = document.createElement('div');
  form.className = 'dj-form project-form';
  form.innerHTML = `
    <input id="new-project-name" type="text" placeholder="project name" />
    <div class="dj-row">
      <input id="new-project-path" type="text" placeholder="repository path" />
      <button id="choose-project-path" class="button-secondary" type="button">browse</button>
    </div>
    <label class="dj-check"><input id="allow-non-git" type="checkbox" /> allow folder without Git</label>
    <div class="dj-row">
      <button id="new-project-btn" class="button-primary" type="button">create project</button>
      <button id="open-existing-btn" class="button-secondary" type="button">open existing</button>
    </div>
  `;

  const status = document.createElement('div');
  status.className = 'dj-status';
  status.style.marginTop = '6px';
  status.style.color = '#f88';
  form.appendChild(status);

  container.appendChild(form);

  if (projects.length > 0) {
    const settingsFooter = document.createElement('div');
    settingsFooter.className = 'project-settings-footer';
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'project-settings-button';
    settingsButton.title = 'settings';
    settingsButton.setAttribute('aria-label', 'settings');
    settingsButton.addEventListener('click', () => openProjectSettingsWindow(win));
    settingsFooter.appendChild(settingsButton);
    container.appendChild(settingsFooter);
  }

  win.setContent(container);
  const projectsWindowHeight = Math.min(570, window.innerHeight - 60);
  win.fitContentHeight(projectsWindowHeight, projectsWindowHeight);

  const nameInput = form.querySelector('#new-project-name');
  const pathInput = form.querySelector('#new-project-path');
  const choosePathButton = form.querySelector('#choose-project-path');
  const openExistingButton = form.querySelector('#open-existing-btn');
  const allowNonGitInput = form.querySelector('#allow-non-git');

  nameInput.addEventListener('input', () => { status.textContent = ''; });
  pathInput.addEventListener('input', () => { status.textContent = ''; });

  choosePathButton.addEventListener('click', async () => {
    const selected = await window.journal.chooseProjectPath();
    if (selected) {
      pathInput.value = selected;
    }
  });

  openExistingButton.addEventListener('click', async () => {
    const projectPath = pathInput.value.trim();
    status.textContent = '';
    if (!projectPath) {
      status.style.color = '#f88';
      status.textContent = 'enter an existing project path or choose one.';
      return;
    }

    try {
      const project = await window.journal.openProjectPath({
        path: projectPath,
        allowNonGit: allowNonGitInput.checked,
      });
      nameInput.value = project.name;
      pathInput.value = project.path;
      status.style.color = '#8f8';
      status.textContent = `project "${project.name}" opened.`;
      await renderProjectsContent(win);
      openProjectWindow(project);
    } catch (error) {
      status.style.color = '#f88';
      status.textContent = `failed to open project: ${error?.message ?? error}`;
      console.error('open existing project failed', error);
    }
  });

  form.querySelector('#new-project-btn').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const path = pathInput.value.trim();
    status.textContent = '';
    if (!name || !path) {
      status.style.color = '#f88';
      status.textContent = 'enter a name and repository path.';
      return;
    }

    try {
      const project = await window.journal.createProject({
        name,
        path,
        allowNonGit: allowNonGitInput.checked,
      });
      nameInput.value = '';
      pathInput.value = '';
      status.style.color = '#8f8';
      status.textContent = `project "${project.name}" created.`;
      await renderProjectsContent(win);
      openProjectWindow(project);
    } catch (error) {
      status.style.color = '#f88';
      status.textContent = `failed to create project: ${error?.message ?? error}`;
      console.error('project create failed', error);
    }
  });
}

function slugTitle(name) {
  return name.trim().toUpperCase().replace(/\s+/g, '_') + '.TXT';
}

function workspaceLayout() {
  const margin = 22;
  const centerWidth = Math.min(460, Math.max(360, window.innerWidth * 0.42));
  const sideWidth = Math.min(320, Math.max(260, (window.innerWidth - centerWidth) / 2 - margin * 2));
  const centerX = (window.innerWidth - centerWidth) / 2;
  return {
    project: { x: centerX, y: 46, width: centerWidth, height: Math.max(520, window.innerHeight - 82) },
    note: { x: margin, y: 52, width: sideWidth, height: 310 },
    checkpoint: { x: window.innerWidth - sideWidth - margin, y: 38, width: sideWidth, height: 370 },
    research: { x: margin, y: Math.max(382, window.innerHeight - 310), width: sideWidth, height: 286 },
    experiment: { x: margin + 34, y: Math.max(118, window.innerHeight / 2 - 210), width: Math.min(360, sideWidth + 50), height: 420 },
    decisions: { x: window.innerWidth - sideWidth - margin, y: Math.max(426, window.innerHeight - 325), width: sideWidth, height: 300 },
    xray: { x: Math.max(26, centerX - 150), y: 32, width: Math.min(780, window.innerWidth - 52), height: Math.max(520, window.innerHeight - 64) },
  };
}

function mountCompanionWindow(project, kind, title, content, startHidden = false) {
  const id = `${kind}:${project.id}`;
  let companion = getDJWindow(id);
  let created = false;
  if (!companion) {
    const dockLabels = { note: 'note', checkpoint: 'checkpoint', research: 'research', experiment: 'experiment' };
    companion = new DJWindow({
      id,
      title,
      ...workspaceLayout()[kind],
      dockable: true,
      dockLabel: dockLabels[kind] || kind,
    });
    companion.el.classList.add('companion-window');
    companion.mount(layer);
    companion.setContent(content);
    created = true;
  }
  connectDJWindows(`project:${project.id}`, id);
  if (created && startHidden) companion.hide();
  return companion;
}

async function focusProjectTool(project, projectWin, kind) {
  let tool = getDJWindow(`${kind}:${project.id}`);
  if (!tool) {
    if (kind === 'decisions') await openDecisionsWindow(project);
    else await renderProjectWindowContent(projectWin, project);
    tool = getDJWindow(`${kind}:${project.id}`);
  }
  if (tool?.isMinimized) tool.toggleMinimize();
  tool?.bringToFront();
}

function closeProjectTools(projectId) {
  for (const kind of ['note', 'checkpoint', 'decisions', 'research', 'experiment', 'resume', 'xray']) {
    getDJWindow(`${kind}:${projectId}`)?.destroy();
  }
}

function minimizeProjectsWindow() {
  const projectsWin = getDJWindow('projects');
  projectsWin?.hide();
}

async function openEntryWindow(entry, projectWin, project) {
  const winId = 'entry:' + entry.id;
  const existing = getDJWindow(winId);
  if (existing) {
    existing.bringToFront();
    return;
  }

  const titleText = `NOTE: ${(entry.title || 'entry').trim()}`;
  const win = new DJWindow({
    id: winId,
    title: titleText.slice(0, 40),
    x: 520 + Math.random() * 40,
    y: 120 + Math.random() * 40,
    width: 420,
    height: 420,
  });
  win.mount(layer);
  connectDJWindows(`project:${project.id}`, winId);

  const container = document.createElement('div');
  const details = document.createElement('div');
  details.className = 'txt-lines';
  const lines = [
    makeLine(null, '[ ENTRY ]', 'accent section-heading'),
    makeLine(null, `title: ${entry.title}`),
    makeLine(null, `source: ${entry.source}`),
    makeLine(null, `created: ${formatDate(entry.createdAt)}`),
    makeLine(null, `updated: ${formatDate(entry.updatedAt)}`),
  ];

  lines.forEach((line) => details.appendChild(line));
  if (entry.tags?.length) details.appendChild(makeLine(null, `tags: ${entry.tags.join(', ')}`));
  if (entry.commitHashes?.length) {
    details.appendChild(makeLine(null, `commits: ${entry.commitHashes.map((hash) => hash.slice(0, 7)).join(', ')}`));
  }
  container.appendChild(details);

  const form = document.createElement('div');
  form.className = 'dj-form';
  form.innerHTML = `
    <input id="edit-entry-title" type="text" value="${escapeHtml(entry.title)}" />
    <textarea id="edit-entry-body" rows="14"></textarea>
    <input id="edit-entry-tags" type="text" placeholder="tags, comma-separated" value="${escapeHtml((entry.tags ?? []).join(', '))}" />
    <input id="edit-entry-commits" type="text" placeholder="commit hashes, comma-separated" value="${escapeHtml((entry.commitHashes ?? []).join(', '))}" />
    <div class="dj-row">
      <button id="save-entry-btn" class="button-primary" type="button">save changes</button>
      <button id="delete-entry-btn" class="button-danger" type="button">delete</button>
    </div>
    <div class="dj-status"></div>
  `;
  form.querySelector('#edit-entry-body').value = entry.bodyMd ?? '';
  container.appendChild(form);

  const status = form.querySelector('.dj-status');
  form.querySelector('#save-entry-btn').addEventListener('click', async () => {
    const title = form.querySelector('#edit-entry-title').value.trim();
    if (!title) {
      status.textContent = 'enter a title.';
      return;
    }
    try {
      entry = await window.journal.updateEntry({
        id: entry.id,
        title,
        bodyMd: form.querySelector('#edit-entry-body').value,
        tags: form.querySelector('#edit-entry-tags').value.split(','),
        commitHashes: form.querySelector('#edit-entry-commits').value.split(','),
      });
      status.textContent = 'entry updated.';
      await renderProjectWindowContent(projectWin, project);
    } catch (error) {
      status.textContent = `failed to update entry: ${error?.message ?? error}`;
    }
  });
  form.querySelector('#delete-entry-btn').addEventListener('click', async () => {
    if (!window.confirm(`delete “${entry.title}”?`)) return;
    await window.journal.deleteEntry(entry.id);
    win.close();
    await renderProjectWindowContent(projectWin, project);
  });

  win.setContent(container);
}

function appendMemoryField(container, label, value, cls = '') {
  if (!value) return;
  container.appendChild(makeLine(null, `${label}: ${value}`, cls));
}

async function openWhyContextWindow(project, kind, memoryId) {
  const winId = `why:${kind}:${memoryId}`;
  const existing = getDJWindow(winId);
  if (existing) {
    existing.bringToFront();
    return;
  }
  const chain = await window.journal.getWhyContext(project.id, kind, memoryId);
  const win = new DJWindow({
    id: winId,
    title: 'WHY?',
    x: Math.max(80, window.innerWidth / 2 - 210),
    y: 90,
    width: 420,
    height: 390,
  });
  win.mount(layer);
  connectDJWindows(`project:${project.id}`, winId);
  const content = document.createElement('div');
  content.className = 'txt-lines';
  content.appendChild(makeLine(null, '[ WHY? ]', 'accent center section-heading'));
  if (chain.length <= 1) {
    content.appendChild(makeLine(null, 'no recorded reason found.', 'dim'));
  } else {
    for (const item of chain) {
      const prefix = item.depth === 0 ? '' : `${'  '.repeat(item.depth)}↳ ${item.relation}: `;
      content.appendChild(makeLine(null, `${prefix}[${item.kind}] ${item.title}`, item.depth ? 'dim' : ''));
    }
  }
  win.setContent(content);
}

function openMemoryItemWindow(kind, item, project) {
  const winId = `${kind}-view:${item.id}`;
  const existing = getDJWindow(winId);
  if (existing) {
    existing.bringToFront();
    return;
  }
  const win = new DJWindow({
    id: winId,
    title: `${kind.toUpperCase()}: ${item.title}`.slice(0, 48),
    x: Math.max(90, window.innerWidth / 2 - 230 + Math.random() * 50),
    y: 90 + Math.random() * 45,
    width: 460,
    height: 430,
  });
  win.mount(layer);
  connectDJWindows(`project:${project.id}`, winId);
  const content = document.createElement('div');
  content.className = 'txt-lines';
  content.appendChild(makeLine(null, `[ ${kind.toUpperCase()} ]`, 'accent center section-heading'));
  content.appendChild(makeLine(null, `title: ${item.title}`));
  if (kind === 'checkpoint') {
    for (const [label, value] of [
      ['working on', item.workingOn], ['works', item.currentWorks],
      ['unfinished', item.brokenOrUnfinished], ['understanding', item.tryingToUnderstand],
      ['decisions', item.decisionsMade], ['rejected', item.alternativesRejected],
      ['questions', item.openQuestions], ['next', item.nextStep], ['notes', item.note],
    ]) appendMemoryField(content, label, value, label === 'notes' ? 'dim' : '');
  } else if (kind === 'experiment') {
    for (const [label, value] of [
      ['status', item.status], ['date', item.experimentDate], ['hypothesis', item.hypothesis],
      ['tested', item.tested], ['method', item.method], ['result', item.result],
      ['conclusion', item.conclusion], ['notes', item.notes],
    ]) appendMemoryField(content, label, value, label === 'notes' ? 'dim' : '');
    if (item.filePaths?.length) appendMemoryField(content, 'files', item.filePaths.join(', '), 'dim');
    if (item.commitHashes?.length) appendMemoryField(content, 'commits', item.commitHashes.map((hash) => hash.slice(0, 7)).join(', '), 'dim');
    const why = document.createElement('button');
    why.type = 'button';
    why.className = 'button-secondary contextual-action';
    why.textContent = 'why?';
    why.addEventListener('click', () => openWhyContextWindow(project, 'experiment', item.id));
    content.appendChild(why);
  } else {
    appendMemoryField(content, 'type', item.type);
    appendMemoryField(content, 'learned', item.notes);
    if (item.pathOrUrl) content.appendChild(createMediaPreview(item.type, item.pathOrUrl));
  }
  win.setContent(content);
}

async function openResumeWindow(project) {
  const winId = 'resume:' + project.id;
  const existing = getDJWindow(winId);
  if (existing) {
    existing.bringToFront();
    return;
  }
  const win = new DJWindow({
    id: winId,
    title: 'RESUME FROM HERE',
    x: 110,
    y: 45,
    width: 620,
    height: 650,
  });
  win.mount(layer);
  connectDJWindows(`project:${project.id}`, winId);
  const context = await window.journal.getResumeContext(project.id);
  const content = document.createElement('div');
  content.className = 'txt-lines';
  content.appendChild(makeLine(null, '[ RESUME FROM HERE ]', 'accent center section-heading'));
  content.appendChild(makeLine(null, `last active: ${formatDate(context.lastActiveAt)} (${context.inactiveDays} day(s) ago)`));
  content.appendChild(makeLine(null, `since checkpoint: ${context.commitsSinceCheckpoint} commit(s)`));
  content.appendChild(makeLine(null, `working tree: ${context.changedFiles} changed file(s)`));
  content.appendChild(makeLine(null, `related research: ${context.researchCount} item(s)`));
  content.appendChild(makeLine(null, `experiments: ${context.experimentCount ?? 0} item(s)`));

  const checkpoint = context.latestCheckpoint;
  content.appendChild(makeLine(null, '[ LAST CHECKPOINT ]', 'accent section-heading'));
  if (!checkpoint) {
    content.appendChild(makeLine(null, 'no checkpoint yet. create one before leaving the project.', 'dim'));
  } else {
    content.appendChild(makeLine(null, checkpoint.title));
    appendMemoryField(content, 'you stopped while', checkpoint.workingOn);
    appendMemoryField(content, 'currently works', checkpoint.currentWorks);
    appendMemoryField(content, 'broken / unfinished', checkpoint.brokenOrUnfinished);
    appendMemoryField(content, 'trying to understand', checkpoint.tryingToUnderstand);
    appendMemoryField(content, 'decisions made', checkpoint.decisionsMade);
    appendMemoryField(content, 'alternatives rejected', checkpoint.alternativesRejected);
    appendMemoryField(content, 'open questions', checkpoint.openQuestions);
    appendMemoryField(content, 'notes', checkpoint.note, 'dim');
    if (checkpoint.filePaths?.length) appendMemoryField(content, 'related files', checkpoint.filePaths.join(', '), 'dim');
  }

  content.appendChild(makeLine(null, '[ OPEN DECISIONS ]', 'accent section-heading'));
  if (context.activeDecisions.length === 0) {
    content.appendChild(makeLine(null, 'no active or experimental decisions.', 'dim'));
  } else {
    for (const decision of context.activeDecisions) {
      content.appendChild(makeLine(null, `• [${decision.status}] ${decision.title}`));
      appendMemoryField(content, '  reason', decision.reason, 'dim');
    }
  }

  content.appendChild(makeLine(null, '[ RECENT MEMORY ]', 'accent section-heading'));
  if (context.recentEntries.length === 0) {
    content.appendChild(makeLine(null, 'no notes since the last checkpoint.', 'dim'));
  } else {
    for (const entry of context.recentEntries) {
      content.appendChild(makeLine(null, `• ${entry.title}`, entry.source === 'auto' ? 'dim' : ''));
    }
  }

  content.appendChild(makeLine(null, '[ ACTIVE EXPERIMENTS ]', 'accent section-heading'));
  if (!context.runningExperiments?.length) {
    content.appendChild(makeLine(null, 'no planned or running experiments.', 'dim'));
  } else {
    for (const experiment of context.runningExperiments.slice(0, 5)) {
      content.appendChild(makeLine(null, `• [${experiment.status}] ${experiment.title}`));
      appendMemoryField(content, '  hypothesis', experiment.hypothesis, 'dim');
    }
  }

  content.appendChild(makeLine(null, '[ SUGGESTED NEXT STEP ]', 'accent section-heading'));
  content.appendChild(makeLine(null, context.suggestedNextStep));
  win.setContent(content);
}

async function renderDecisionsContent(win, project) {
  const [decisions, checkpoints, entries, research, assumptions] = await Promise.all([
    window.journal.listDecisions(project.id),
    window.journal.listCheckpoints(project.id),
    window.journal.listEntries(project.id),
    window.journal.listResearch(project.id),
    window.journal.listAssumptions(project.id),
  ]);
  const container = document.createElement('div');

  const children = new Map();
  for (const decision of decisions) {
    const parentId = decision.parentDecisionId && decisions.some((item) => item.id === decision.parentDecisionId)
      ? decision.parentDecisionId
      : null;
    const list = children.get(parentId) ?? [];
    list.push(decision);
    children.set(parentId, list);
  }

  const tree = document.createElement('div');
  tree.className = 'decision-tree';
  const visited = new Set();
  const renderBranch = (parentId, depth) => {
    for (const decision of children.get(parentId) ?? []) {
      if (visited.has(decision.id)) continue;
      visited.add(decision.id);
      const card = document.createElement('div');
      card.className = `decision-card status-${decision.status}`;
      card.style.marginLeft = `${Math.min(depth, 6) * 20}px`;

      const heading = document.createElement('div');
      heading.className = 'decision-heading';
      heading.textContent = `${depth ? '↳ ' : ''}${decision.title}`;
      card.appendChild(heading);
      appendMemoryField(card, 'reason', decision.reason);
      appendMemoryField(card, 'notes', decision.notes, 'dim');
      if (decision.temporary) {
        appendMemoryField(card, 'temporary', decision.revisitDate ? `revisit ${decision.revisitDate}` : (decision.revisitCondition || 'review later'), 'decision-debt');
      }
      if (decision.commitHashes.length) appendMemoryField(card, 'commits', decision.commitHashes.map((hash) => hash.slice(0, 7)).join(', '), 'dim');
      if (decision.filePaths.length) appendMemoryField(card, 'files', decision.filePaths.join(', '), 'dim');
      if (decision.researchIds.length) {
        const titles = decision.researchIds.map((id) => research.find((item) => item.id === id)?.title ?? id);
        appendMemoryField(card, 'research', titles.join(', '), 'dim');
      }
      if (decision.assumptionIds?.length) {
        const statements = decision.assumptionIds.map((id) => assumptions.find((item) => item.id === id)).filter(Boolean);
        appendMemoryField(card, 'assumptions', statements.map((item) => `[${item.status}] ${item.statement}`).join(', '), statements.some((item) => item.status !== 'active') ? 'possible' : 'dim');
      }

      const controls = document.createElement('div');
      controls.className = 'dj-row decision-controls';
      const statusSelect = document.createElement('select');
      for (const status of ['active', 'experimental', 'superseded', 'rejected']) {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = status;
        option.selected = status === decision.status;
        statusSelect.appendChild(option);
      }
      const replacementSelect = document.createElement('select');
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = 'no replacement';
      replacementSelect.appendChild(emptyOption);
      for (const candidate of decisions.filter((item) => item.id !== decision.id)) {
        const option = document.createElement('option');
        option.value = candidate.id;
        option.textContent = `replaced by: ${candidate.title}`;
        option.selected = candidate.id === decision.replacementDecisionId;
        replacementSelect.appendChild(option);
      }
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'button-secondary';
      save.textContent = 'update';
      save.addEventListener('click', async () => {
        await window.journal.updateDecision({
          id: decision.id,
          status: statusSelect.value,
          replacementDecisionId: replacementSelect.value || null,
          commitHashes: decision.commitHashes,
          filePaths: decision.filePaths,
          entryIds: decision.entryIds,
          researchIds: decision.researchIds,
          assumptionIds: decision.assumptionIds,
          temporary: decision.temporary,
          revisitCondition: decision.revisitCondition,
          revisitDate: decision.revisitDate,
          reviewStatus: decision.reviewStatus,
        });
        await renderDecisionsContent(win, project);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button-danger';
      remove.textContent = 'delete';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`delete decision “${decision.title}”?`)) return;
        await window.journal.deleteDecision(decision.id);
        await renderDecisionsContent(win, project);
      });
      controls.appendChild(statusSelect);
      controls.appendChild(replacementSelect);
      controls.appendChild(save);
      controls.appendChild(remove);
      const why = document.createElement('button');
      why.type = 'button';
      why.className = 'button-secondary';
      why.textContent = 'why?';
      why.addEventListener('click', () => openWhyContextWindow(project, 'decision', decision.id));
      controls.appendChild(why);
      card.appendChild(controls);
      tree.appendChild(card);
      renderBranch(decision.id, depth + 1);
    }
  };
  renderBranch(null, 0);
  container.appendChild(tree);

  if (assumptions.length) {
    const assumptionPanel = document.createElement('details');
    assumptionPanel.className = 'advanced-fields assumption-panel';
    const summary = document.createElement('summary');
    summary.textContent = `assumptions (${assumptions.length})`;
    assumptionPanel.appendChild(summary);
    for (const assumption of assumptions) {
      const row = document.createElement('div');
      row.className = 'assumption-row';
      const statement = document.createElement('span');
      statement.textContent = assumption.statement;
      statement.title = assumption.notes || assumption.statement;
      const statusSelect = document.createElement('select');
      for (const value of ['active', 'questioned', 'invalidated']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        option.selected = value === assumption.status;
        statusSelect.appendChild(option);
      }
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'button-secondary';
      save.textContent = 'update';
      save.addEventListener('click', async () => {
        await window.journal.updateAssumption({ id: assumption.id, status: statusSelect.value });
        await renderDecisionsContent(win, project);
      });
      row.appendChild(statement);
      row.appendChild(statusSelect);
      row.appendChild(save);
      assumptionPanel.appendChild(row);
    }
    container.appendChild(assumptionPanel);
  }

  const form = document.createElement('div');
  form.className = 'dj-form';
  form.innerHTML = `
    <input id="decision-title" type="text" placeholder="decision or technical idea" />
    <select id="decision-status">
      <option value="active">active</option>
      <option value="experimental">experimental</option>
      <option value="superseded">superseded</option>
      <option value="rejected">rejected</option>
    </select>
    <textarea id="decision-reason" rows="3" placeholder="why this decision exists"></textarea>
    <textarea id="decision-notes" rows="2" placeholder="notes / assumptions / consequences"></textarea>
    <label class="field-label">evolves from<select id="decision-parent"><option value="">root decision</option></select></label>
    <label class="field-label">related checkpoint<select id="decision-checkpoint"><option value="">no checkpoint</option></select></label>
    <label class="field-label">related notes<select id="decision-entries" multiple size="3"></select></label>
    <label class="field-label">related research<select id="decision-research" multiple size="3"></select></label>
    <label class="field-label">based on assumptions<select id="decision-assumptions" multiple size="3"></select></label>
    <input id="decision-new-assumption" type="text" placeholder="new assumption, optional" />
    <label class="dj-check"><input id="decision-temporary" type="checkbox" /> temporary decision</label>
    <input id="decision-revisit-condition" type="text" placeholder="revisit when…" />
    <label class="field-label">revisit date<input id="decision-revisit-date" type="date" /></label>
    <input id="decision-files" type="text" placeholder="related files, comma-separated" />
    <input id="decision-commits" type="text" placeholder="commit hashes, comma-separated" value="${escapeHtml(project.lastHeadHash ?? '')}" />
    <button id="create-decision-btn" class="button-primary" type="button">add decision</button>
    <div class="dj-status"></div>
  `;
  const parentSelect = form.querySelector('#decision-parent');
  for (const decision of decisions) {
    const option = document.createElement('option');
    option.value = decision.id;
    option.textContent = decision.title;
    parentSelect.appendChild(option);
  }
  const checkpointSelect = form.querySelector('#decision-checkpoint');
  for (const checkpoint of checkpoints) {
    const option = document.createElement('option');
    option.value = checkpoint.id;
    option.textContent = checkpoint.title;
    checkpointSelect.appendChild(option);
  }
  const entriesSelect = form.querySelector('#decision-entries');
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.title;
    entriesSelect.appendChild(option);
  }
  const researchSelect = form.querySelector('#decision-research');
  for (const item of research) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `research: ${item.title}`;
    researchSelect.appendChild(option);
  }
  const assumptionsSelect = form.querySelector('#decision-assumptions');
  for (const assumption of assumptions) {
    const option = document.createElement('option');
    option.value = assumption.id;
    option.textContent = `[${assumption.status}] ${assumption.statement}`;
    assumptionsSelect.appendChild(option);
  }
  form.querySelector('#create-decision-btn').addEventListener('click', async () => {
    const title = form.querySelector('#decision-title').value.trim();
    const status = form.querySelector('.dj-status');
    if (!title) {
      status.textContent = 'enter a decision title.';
      return;
    }
    try {
      const assumptionIds = [...assumptionsSelect.selectedOptions].map((option) => option.value);
      const newAssumption = form.querySelector('#decision-new-assumption').value.trim();
      if (newAssumption) {
        const created = await window.journal.createAssumption({ projectId: project.id, statement: newAssumption });
        assumptionIds.push(created.id);
      }
      await window.journal.createDecision({
        projectId: project.id,
        title,
        status: form.querySelector('#decision-status').value,
        reason: form.querySelector('#decision-reason').value.trim(),
        notes: form.querySelector('#decision-notes').value.trim(),
        parentDecisionId: parentSelect.value || null,
        checkpointId: checkpointSelect.value || null,
        filePaths: form.querySelector('#decision-files').value.split(','),
        commitHashes: form.querySelector('#decision-commits').value.split(','),
        entryIds: [...entriesSelect.selectedOptions].map((option) => option.value),
        researchIds: [...researchSelect.selectedOptions].map((option) => option.value),
        assumptionIds,
        temporary: form.querySelector('#decision-temporary').checked,
        revisitCondition: form.querySelector('#decision-revisit-condition').value.trim(),
        revisitDate: form.querySelector('#decision-revisit-date').value || null,
        reviewStatus: 'pending',
      });
      await renderDecisionsContent(win, project);
    } catch (error) {
      status.textContent = `failed to create decision: ${error?.message ?? error}`;
    }
  });
  container.appendChild(form);
  win.setContent(container);
}

async function openDecisionsWindow(project) {
  const winId = 'decisions:' + project.id;
  const existing = getDJWindow(winId);
  if (existing) {
    existing.bringToFront();
    return;
  }
  const win = new DJWindow({
    id: winId,
    title: 'DECISIONS',
    ...workspaceLayout().decisions,
    dockable: true,
    dockLabel: 'decisions',
  });
  win.el.classList.add('companion-window');
  win.mount(layer);
  connectDJWindows(`project:${project.id}`, winId);
  await renderDecisionsContent(win, project);
}

function createExperimentForm(project, projectWin, entries, research, decisions, assumptions) {
  const form = document.createElement('div');
  form.className = 'dj-form experiment-form';
  form.innerHTML = `
    <input id="experiment-title" type="text" placeholder="experiment title" />
    <select id="experiment-status">
      <option value="planned">planned</option>
      <option value="running">running</option>
      <option value="successful">successful</option>
      <option value="failed">failed</option>
      <option value="inconclusive">inconclusive</option>
      <option value="abandoned">abandoned</option>
    </select>
    <label class="field-label">date<input id="experiment-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
    <textarea id="experiment-hypothesis" rows="2" placeholder="hypothesis / question"></textarea>
    <textarea id="experiment-tested" rows="2" placeholder="what was tested"></textarea>
    <textarea id="experiment-method" rows="2" placeholder="method / approach"></textarea>
    <textarea id="experiment-result" rows="2" placeholder="result"></textarea>
    <textarea id="experiment-conclusion" rows="2" placeholder="conclusion"></textarea>
    <details class="advanced-fields">
      <summary>relationships and notes</summary>
      <label class="field-label">related research<select id="experiment-research" multiple size="3"></select></label>
      <label class="field-label">assumptions<select id="experiment-assumptions" multiple size="3"></select></label>
      <input id="experiment-new-assumption" type="text" placeholder="new assumption, optional" />
      <label class="field-label">resulting decision<select id="experiment-decision"><option value="">no decision yet</option></select></label>
      <label class="field-label">related notes<select id="experiment-entries" multiple size="3"></select></label>
      <input id="experiment-files" type="text" placeholder="related files, comma-separated" />
      <input id="experiment-commits" type="text" placeholder="commit hashes, comma-separated" value="${escapeHtml(project.lastHeadHash ?? '')}" />
      <textarea id="experiment-notes" rows="2" placeholder="optional notes"></textarea>
    </details>
    <button id="experiment-save" class="button-primary" type="button">save experiment</button>
    <div class="dj-status"></div>
  `;
  const addOptions = (selector, items, label) => {
    const select = form.querySelector(selector);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = label(item);
      select.appendChild(option);
    }
    return select;
  };
  const researchSelect = addOptions('#experiment-research', research, (item) => item.title);
  const assumptionSelect = addOptions('#experiment-assumptions', assumptions, (item) => `[${item.status}] ${item.statement}`);
  const decisionSelect = addOptions('#experiment-decision', decisions, (item) => item.title);
  const entrySelect = addOptions('#experiment-entries', entries, (item) => item.title);
  form.querySelector('#experiment-save').addEventListener('click', async () => {
    const status = form.querySelector('.dj-status');
    const title = form.querySelector('#experiment-title').value.trim();
    if (!title) {
      status.textContent = 'enter an experiment title.';
      return;
    }
    try {
      const assumptionIds = [...assumptionSelect.selectedOptions].map((option) => option.value);
      const newAssumption = form.querySelector('#experiment-new-assumption').value.trim();
      if (newAssumption) {
        const created = await window.journal.createAssumption({ projectId: project.id, statement: newAssumption });
        assumptionIds.push(created.id);
      }
      await window.journal.createExperiment({
        projectId: project.id,
        title,
        status: form.querySelector('#experiment-status').value,
        experimentDate: form.querySelector('#experiment-date').value,
        hypothesis: form.querySelector('#experiment-hypothesis').value.trim(),
        tested: form.querySelector('#experiment-tested').value.trim(),
        method: form.querySelector('#experiment-method').value.trim(),
        result: form.querySelector('#experiment-result').value.trim(),
        conclusion: form.querySelector('#experiment-conclusion').value.trim(),
        notes: form.querySelector('#experiment-notes').value.trim(),
        resultingDecisionId: decisionSelect.value || null,
        researchIds: [...researchSelect.selectedOptions].map((option) => option.value),
        assumptionIds,
        entryIds: [...entrySelect.selectedOptions].map((option) => option.value),
        filePaths: form.querySelector('#experiment-files').value.split(','),
        commitHashes: form.querySelector('#experiment-commits').value.split(','),
      });
      for (const input of form.querySelectorAll('input:not(#experiment-date):not(#experiment-commits), textarea')) input.value = '';
      for (const option of form.querySelectorAll('select option')) option.selected = false;
      form.querySelector('#experiment-status').value = 'planned';
      form.querySelector('#experiment-date').value = new Date().toISOString().slice(0, 10);
      status.textContent = 'experiment saved.';
      await renderProjectWindowContent(projectWin, project);
    } catch (error) {
      status.textContent = `failed to save experiment: ${error?.message ?? error}`;
    }
  });
  return form;
}

function xrayValueBlock(title, values, className = '') {
  const block = document.createElement('div');
  block.className = `xray-value ${className}`.trim();
  const heading = document.createElement('div');
  heading.className = 'xray-label';
  heading.textContent = title;
  block.appendChild(heading);
  const items = Array.isArray(values) ? values : [values];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dim';
    empty.textContent = 'none';
    block.appendChild(empty);
  } else {
    for (const value of items) {
      const line = document.createElement('div');
      line.textContent = value;
      block.appendChild(line);
    }
  }
  return block;
}

function xrayTrace(nodeId, nodesById) {
  const paths = [];
  const walk = (id, path, seen) => {
    if (seen.has(id)) return;
    const node = nodesById.get(id);
    if (!node) return;
    const nextPath = [node.name, ...path];
    if (node.direct || node.parentIds.length === 0) {
      paths.push(['PROJECT', ...nextPath].join('  >  '));
      return;
    }
    const nextSeen = new Set(seen).add(id);
    for (const parentId of node.parentIds) walk(parentId, nextPath, nextSeen);
  };
  walk(nodeId, [], new Set());
  return [...new Set(paths)].slice(0, 12);
}

async function renderXrayContent(win, project, report, memoryItems) {
  const nodesById = new Map(report.nodes.map((node) => [node.id, node]));
  let selectedId = report.rootDependencyIds[0] ?? report.nodes[0]?.id ?? null;
  const container = document.createElement('div');
  container.className = 'xray-module';

  const header = document.createElement('div');
  header.className = 'xray-header';
  const summary = document.createElement('div');
  summary.className = 'dim';
  summary.textContent = `${report.nodes.length} packages · ${report.rootDependencyIds.length} direct · ${report.edges.length} relationships`;
  header.appendChild(summary);
  container.appendChild(header);

  const toolbar = document.createElement('div');
  toolbar.className = 'dj-row xray-toolbar';
  toolbar.innerHTML = `
    <input class="xray-search" type="search" placeholder="search dependencies" aria-label="search dependencies" />
    <button class="button-secondary xray-refresh" type="button">refresh</button>
  `;
  container.appendChild(toolbar);

  const notices = document.createElement('div');
  notices.className = 'xray-notices';
  for (const warning of report.warnings) notices.appendChild(xrayValueBlock('NOTICE', warning, 'possible'));
  container.appendChild(notices);

  const workspace = document.createElement('div');
  workspace.className = 'xray-workspace';
  const graph = document.createElement('div');
  graph.className = 'xray-graph';
  const detail = document.createElement('div');
  detail.className = 'xray-detail';
  workspace.appendChild(graph);
  workspace.appendChild(detail);
  container.appendChild(workspace);

  const selectNode = (id) => {
    selectedId = id;
    for (const button of graph.querySelectorAll('.xray-node')) {
      button.classList.toggle('selected', button.dataset.nodeId === id);
    }
    renderDetail();
  };

  const makeNode = (node, depth, repeated = false) => {
    const row = document.createElement('div');
    row.className = 'xray-tree-row';
    row.style.setProperty('--depth', String(depth));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `xray-node${node.direct ? ' direct' : ''}${node.id === selectedId ? ' selected' : ''}`;
    button.dataset.nodeId = node.id;
    button.textContent = `${node.direct ? '◆' : '◇'} ${node.name} @ ${node.version}${repeated ? '  ↩' : ''}`;
    button.addEventListener('click', () => selectNode(node.id));
    row.appendChild(button);
    return row;
  };

  const renderGraph = (query = '') => {
    graph.innerHTML = '';
    const normalized = query.trim().toLowerCase();
    if (normalized) {
      const matches = report.nodes.filter((node) => `${node.name} ${node.version}`.toLowerCase().includes(normalized));
      for (const node of matches) graph.appendChild(makeNode(node, 0));
      if (matches.length === 0) graph.appendChild(xrayValueBlock('SEARCH', 'no matching dependencies', 'possible'));
      return;
    }
    if (report.nodes.length === 0) {
      graph.appendChild(xrayValueBlock('PROJECT', 'no dependencies found', 'possible'));
      return;
    }
    const projectRoot = document.createElement('div');
    projectRoot.className = 'xray-project-root';
    projectRoot.textContent = 'PROJECT';
    graph.appendChild(projectRoot);
    const renderBranch = (id, depth, path) => {
      const node = nodesById.get(id);
      if (!node) return;
      const repeated = path.has(id);
      graph.appendChild(makeNode(node, depth, repeated));
      if (repeated || depth >= 8) return;
      const nextPath = new Set(path).add(id);
      for (const childId of node.children) renderBranch(childId, depth + 1, nextPath);
    };
    for (const id of report.rootDependencyIds) renderBranch(id, 0, new Set());
  };

  const renderDetail = () => {
    detail.innerHTML = '';
    const node = nodesById.get(selectedId);
    if (!node) {
      detail.appendChild(xrayValueBlock('PACKAGE', 'select a dependency', 'possible'));
      return;
    }
    const parents = node.parentIds.map((id) => nodesById.get(id)?.name ?? id);
    const children = node.children.map((id) => nodesById.get(id)?.name ?? id);
    detail.appendChild(xrayValueBlock('PACKAGE', node.name));
    detail.appendChild(xrayValueBlock('VERSION', `${node.version}${node.resolved ? '' : ' (requested, unresolved)'}`));
    detail.appendChild(xrayValueBlock('TYPE', node.direct ? `direct ${node.directKind ?? ''} dependency`.trim() : 'transitive dependency'));
    detail.appendChild(xrayValueBlock('WHY IS IT HERE?', node.direct ? 'Declared directly by the project.' : parents.map((name) => `${name} depends on it.`)));
    detail.appendChild(xrayValueBlock('USED BY', node.usedBy));
    detail.appendChild(xrayValueBlock('TRANSITIVE DEPENDENCIES', String(node.transitiveCount)));
    detail.appendChild(xrayValueBlock('INTRODUCED DEPENDENCIES', children));
    detail.appendChild(xrayValueBlock('PARENTS', node.direct ? ['PROJECT', ...parents] : parents));
    detail.appendChild(xrayValueBlock('RELATED PROJECT MEMORY', node.memoryLinks.map((link) => `${link.kind}: ${link.title}`)));

    const actions = document.createElement('div');
    actions.className = 'dj-row xray-actions';
    const traceButton = document.createElement('button');
    traceButton.type = 'button';
    traceButton.className = 'button-secondary';
    traceButton.textContent = 'trace';
    const simulateButton = document.createElement('button');
    simulateButton.type = 'button';
    simulateButton.className = 'button-secondary';
    simulateButton.textContent = 'simulate removal';
    const whyButton = document.createElement('button');
    whyButton.type = 'button';
    whyButton.className = 'button-secondary';
    whyButton.textContent = 'why?';
    actions.appendChild(traceButton);
    actions.appendChild(simulateButton);
    actions.appendChild(whyButton);
    detail.appendChild(actions);
    const actionResult = document.createElement('div');
    actionResult.className = 'xray-action-result';
    detail.appendChild(actionResult);

    traceButton.addEventListener('click', () => {
      actionResult.innerHTML = '';
      actionResult.appendChild(xrayValueBlock('TRACE TO PROJECT · CONFIRMED', xrayTrace(node.id, nodesById), 'confirmed'));
    });
    whyButton.addEventListener('click', () => openWhyContextWindow(project, 'dependency', node.name));
    simulateButton.addEventListener('click', async () => {
      actionResult.innerHTML = '';
      actionResult.appendChild(xrayValueBlock('SIMULATION', 'calculating…', 'possible'));
      try {
        const simulation = await window.journal.simulateXrayRemoval(project.id, node.id);
        actionResult.innerHTML = '';
        actionResult.appendChild(xrayValueBlock('CONFIRMED · SOURCE USAGE', simulation.confirmedSourceFiles, 'confirmed'));
        actionResult.appendChild(xrayValueBlock('CONFIRMED · RELATIONSHIPS', simulation.confirmedRelationships, 'confirmed'));
        const possibleNames = simulation.possiblyRemovableIds.map((id) => nodesById.get(id)?.name ?? id);
        actionResult.appendChild(xrayValueBlock('POSSIBLE · MAY BECOME UNNECESSARY', possibleNames, 'possible'));
        actionResult.appendChild(xrayValueBlock('POSSIBLE · IMPACT', simulation.possibleImpact, 'possible'));
      } catch (error) {
        actionResult.innerHTML = '';
        actionResult.appendChild(xrayValueBlock('SIMULATION FAILED', error?.message ?? String(error), 'possible'));
      }
    });

    const relationForm = document.createElement('div');
    relationForm.className = 'dj-form xray-memory-form';
    const relationLabel = document.createElement('label');
    relationLabel.className = 'field-label';
    relationLabel.textContent = 'manually relate project memory';
    const relationSelect = document.createElement('select');
    relationSelect.multiple = true;
    relationSelect.size = 5;
    const selectedLinks = new Set(node.memoryLinks.map((link) => `${link.kind}:${link.id}`));
    for (const item of memoryItems) {
      const option = document.createElement('option');
      option.value = `${item.kind}:${item.id}`;
      option.textContent = `[${item.kind}] ${item.title}`;
      option.selected = selectedLinks.has(option.value);
      relationSelect.appendChild(option);
    }
    relationLabel.appendChild(relationSelect);
    const saveRelations = document.createElement('button');
    saveRelations.type = 'button';
    saveRelations.className = 'button-secondary';
    saveRelations.textContent = 'save relationships';
    const relationStatus = document.createElement('div');
    relationStatus.className = 'dj-status';
    relationForm.appendChild(relationLabel);
    relationForm.appendChild(saveRelations);
    relationForm.appendChild(relationStatus);
    detail.appendChild(relationForm);
    saveRelations.addEventListener('click', async () => {
      const links = [...relationSelect.selectedOptions].map((option) => {
        const separator = option.value.indexOf(':');
        return { kind: option.value.slice(0, separator), id: option.value.slice(separator + 1) };
      });
      try {
        await window.journal.setXrayMemoryLinks({ projectId: project.id, dependencyName: node.name, links });
        node.memoryLinks = memoryItems.filter((item) => links.some((link) => link.kind === item.kind && link.id === item.id));
        relationStatus.textContent = 'relationships saved.';
      } catch (error) {
        relationStatus.textContent = `failed to save relationships: ${error?.message ?? error}`;
      }
    });
  };

  win.setContent(container);
  renderGraph();
  renderDetail();
  toolbar.querySelector('.xray-search').addEventListener('input', (event) => renderGraph(event.target.value));
  toolbar.querySelector('.xray-refresh').addEventListener('click', async () => {
    const refreshed = await window.journal.analyzeProjectXray(project.id);
    await renderXrayContent(win, project, refreshed, memoryItems);
  });
}

async function openXrayWindow(project) {
  const winId = `xray:${project.id}`;
  const existing = getDJWindow(winId);
  if (existing) {
    existing.show();
    existing.bringToFront();
    return;
  }
  const win = new DJWindow({
    id: winId,
    title: 'X-RAY',
    ...workspaceLayout().xray,
    dockable: true,
    dockLabel: 'x-ray',
  });
  win.el.classList.add('companion-window', 'xray-window');
  win.mount(layer);
  connectDJWindows(`project:${project.id}`, winId);
  const loading = document.createElement('div');
  loading.className = 'dim';
  loading.textContent = 'scanning dependency structure…';
  win.setContent(loading);
  try {
    const [report, entries, checkpoints, decisions, research, experiments, assumptions] = await Promise.all([
      window.journal.analyzeProjectXray(project.id),
      window.journal.listEntries(project.id),
      window.journal.listCheckpoints(project.id),
      window.journal.listDecisions(project.id),
      window.journal.listResearch(project.id),
      window.journal.listExperiments(project.id),
      window.journal.listAssumptions(project.id),
    ]);
    const memoryItems = [
      ...entries.map((item) => ({ kind: 'journal', id: item.id, title: item.title })),
      ...checkpoints.map((item) => ({ kind: 'checkpoint', id: item.id, title: item.title })),
      ...decisions.map((item) => ({ kind: 'decision', id: item.id, title: item.title })),
      ...research.map((item) => ({ kind: 'research', id: item.id, title: item.title })),
      ...experiments.map((item) => ({ kind: 'experiment', id: item.id, title: item.title })),
      ...assumptions.map((item) => ({ kind: 'assumption', id: item.id, title: item.statement })),
    ];
    await renderXrayContent(win, project, report, memoryItems);
  } catch (error) {
    const failed = document.createElement('div');
    failed.className = 'xray-value possible';
    failed.textContent = `X-Ray scan failed: ${error?.message ?? error}`;
    win.setContent(failed);
  }
}

async function openProjectWindow(project) {
  activeProjectId = project.id;
  const winId = 'project:' + project.id;
  const existing = getDJWindow(winId);
  if (existing) {
    const freshProject = (await window.journal.getProject(project.id)) ?? project;
    await renderProjectWindowContent(existing, freshProject);
    minimizeProjectsWindow();
    existing.bringToFront();
    return;
  }

  const win = new DJWindow({
    id: winId,
    title: slugTitle(project.name),
    ...workspaceLayout().project,
    onClose: () => {
      closeProjectTools(project.id);
      if (activeProjectId === project.id) activeProjectId = null;
    },
  });
  win.mount(layer);
  minimizeProjectsWindow();
  const freshProject = (await window.journal.getProject(project.id)) ?? project;
  await renderProjectWindowContent(win, freshProject);
  const resumeContext = await window.journal.getResumeContext(project.id);
  if (resumeContext.latestCheckpoint && resumeContext.inactiveDays >= 7) {
    await openResumeWindow(freshProject);
  }
}

async function renderProjectWindowContent(win, project) {
  const container = document.createElement('div');
  const linesBox = document.createElement('div');
  linesBox.className = 'txt-lines numbered-lines';
  container.appendChild(linesBox);

  project = (await window.journal.getProject(project.id)) ?? project;
  const [entries, commits, checkpoints, research, experiments, decisions, assumptions, insights, resume] = await Promise.all([
    window.journal.listEntries(project.id),
    window.journal.getCommits(project.id),
    window.journal.listCheckpoints(project.id),
    window.journal.listResearch(project.id),
    window.journal.listExperiments(project.id),
    window.journal.listDecisions(project.id),
    window.journal.listAssumptions(project.id),
    window.journal.getEdiInsights(project.id),
    window.journal.getResumeContext(project.id),
  ]);

  const resumeCard = document.createElement('div');
  resumeCard.className = 'resume-card';
  const resumeTitle = document.createElement('div');
  resumeTitle.className = 'resume-card-title';
  resumeTitle.textContent = 'RESUME FROM HERE';
  const resumeText = document.createElement('div');
  resumeText.className = 'resume-card-text';
  resumeText.textContent = resume.latestCheckpoint
    ? `${resume.latestCheckpoint.workingOn || resume.latestCheckpoint.title} · next: ${resume.suggestedNextStep}`
    : 'no saved mental state yet. create a checkpoint before you leave this project.';
  const resumeButton = document.createElement('button');
  resumeButton.type = 'button';
  resumeButton.className = 'button-primary';
  resumeButton.textContent = resume.latestCheckpoint ? 'open context' : 'create checkpoint';
  resumeButton.addEventListener('click', async () => {
    if (resume.latestCheckpoint) {
      openResumeWindow(project);
      return;
    }
    await focusProjectTool(project, win, 'checkpoint');
    getDJWindow(`checkpoint:${project.id}`)?.bodyEl.querySelector('#checkpoint-title')?.focus();
  });
  resumeCard.appendChild(resumeTitle);
  resumeCard.appendChild(resumeText);
  resumeCard.appendChild(resumeButton);
  container.insertBefore(resumeCard, linesBox);

  let n = 1;
  linesBox.appendChild(makeLine(n++, '[ PROJECT ]', 'accent section-heading'));
  linesBox.appendChild(makeLine(n++, `name: ${project.name}`));
  linesBox.appendChild(makeLine(n++, `path: ${project.path}`));
  linesBox.appendChild(makeLine(n++, `git remote: ${project.gitRemote ?? 'none'}`));
  linesBox.appendChild(makeLine(n++, `last checked: ${project.lastCheckedAt ? formatDate(project.lastCheckedAt) : 'never'}`));
  const workTreeText = project.gitStatus && project.gitStatus !== 'ok'
    ? project.gitStatus
    : project.lastCheckedAt
    ? project.lastWorkingTreeClean
      ? 'clean'
      : 'dirty'
    : 'unknown';
  linesBox.appendChild(makeLine(n++, `working tree: ${workTreeText}`));
  linesBox.appendChild(makeLine(n++, `created: ${formatDate(project.createdAt)}`));
  linesBox.appendChild(makeLine(n++, `notes: ${entries.length}`));
  linesBox.appendChild(makeLine(n++, `experiments: ${experiments.length}`));
  linesBox.appendChild(makeLine(n++, `commits cached: ${commits.length}`));
  linesBox.appendChild(makeLine(n++, ''));

  linesBox.appendChild(makeLine(n++, '[ NOTES ]', 'accent section-heading'));
  if (entries.length === 0) {
    linesBox.appendChild(makeLine(n++, 'no notes yet', 'dim'));
  } else {
    for (const entry of entries.slice(0, 6)) {
      const entryRow = document.createElement('div');
      entryRow.className = 'txt-line accent entry-line';

      const lineNum = document.createElement('span');
      lineNum.className = 'ln';
      lineNum.textContent = String(n++);

      const entryLabel = document.createElement('span');
      entryLabel.className = 'lc';
      entryLabel.textContent = entry.title;
      entryLabel.style.flex = '1';

      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.textContent = '>';
      openButton.className = 'button-secondary button-inline';
      openButton.title = `open note ${entry.title}`;
      openButton.setAttribute('aria-label', `open note ${entry.title}`);
      openButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openEntryWindow(entry, win, project);
      });

      makeInteractiveLine(entryRow, () => openEntryWindow(entry, win, project));

      entryRow.appendChild(lineNum);
      entryRow.appendChild(entryLabel);
      entryRow.appendChild(openButton);
      linesBox.appendChild(entryRow);
    }
  }

  if (commits.length > 0) {
    linesBox.appendChild(makeLine(n++, ''));
    linesBox.appendChild(makeLine(n++, '[ RECENT COMMITS ]', 'accent section-heading'));
    for (const commit of commits.slice(0, 5)) {
      linesBox.appendChild(makeLine(n++, `• ${commit.hash.slice(0, 7)} ${commit.message}`));
      linesBox.appendChild(makeLine(n++, `  ${commit.author} · ${formatDate(commit.date)}`, 'dim'));
    }
    if (commits.length > 5) {
      linesBox.appendChild(makeLine(n++, `... and ${commits.length - 5} more`,'dim'));
    }
  }

  linesBox.appendChild(makeLine(n++, ''));
  linesBox.appendChild(makeLine(n++, '[ CHECKPOINTS ]', 'accent section-heading'));
  if (checkpoints.length === 0) {
    linesBox.appendChild(makeLine(n++, 'no checkpoints yet', 'dim'));
  } else {
    for (const checkpoint of checkpoints.slice(0, 3)) {
      const checkpointLine = makeLine(n++, `◆ ${checkpoint.title}`);
      makeInteractiveLine(checkpointLine, () => openMemoryItemWindow('checkpoint', checkpoint, project));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'inline-delete';
      remove.textContent = '×';
      remove.title = 'delete checkpoint';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm(`delete checkpoint “${checkpoint.title}”?`)) return;
        await window.journal.deleteCheckpoint(checkpoint.id);
        await renderProjectWindowContent(win, project);
      });
      checkpointLine.appendChild(remove);
      linesBox.appendChild(checkpointLine);
      for (const [label, value] of [
        ['working on', checkpoint.workingOn],
        ['works', checkpoint.currentWorks],
        ['unfinished', checkpoint.brokenOrUnfinished],
        ['understanding', checkpoint.tryingToUnderstand],
        ['decisions', checkpoint.decisionsMade],
        ['rejected', checkpoint.alternativesRejected],
        ['questions', checkpoint.openQuestions],
        ['next', checkpoint.nextStep],
      ]) {
        if (value) linesBox.appendChild(makeLine(n++, `  ${label}: ${value}`));
      }
      if (checkpoint.note) linesBox.appendChild(makeLine(n++, `  notes: ${checkpoint.note}`, 'dim'));
      if (checkpoint.commitHashes?.length) {
        linesBox.appendChild(makeLine(n++, `  commits: ${checkpoint.commitHashes.map((hash) => hash.slice(0, 7)).join(', ')}`, 'dim'));
      }
      if (checkpoint.filePaths?.length) {
        linesBox.appendChild(makeLine(n++, `  files: ${checkpoint.filePaths.join(', ')}`, 'dim'));
      }
    }
  }
  linesBox.appendChild(makeLine(n++, ''));
  linesBox.appendChild(makeLine(n++, '[ RESEARCH ]', 'accent section-heading'));
  if (research.length === 0) {
    linesBox.appendChild(makeLine(n++, 'no research saved', 'dim'));
  } else {
    for (const item of research.slice(0, 5)) {
      const researchLine = makeLine(n++, `◇ [${item.type}] ${item.title}`);
      makeInteractiveLine(researchLine, () => openMemoryItemWindow('research', item, project));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'inline-delete';
      remove.textContent = '×';
      remove.title = 'delete research';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm(`delete research “${item.title}”?`)) return;
        await window.journal.deleteResearchItem(item.id);
        await renderProjectWindowContent(win, project);
      });
      researchLine.appendChild(remove);
      linesBox.appendChild(researchLine);
      if (item.pathOrUrl) linesBox.appendChild(makeLine(n++, `  ${item.pathOrUrl}`, 'dim'));
    }
  }
  linesBox.appendChild(makeLine(n++, ''));
  linesBox.appendChild(makeLine(n++, '[ EXPERIMENTS ]', 'accent section-heading'));
  if (experiments.length === 0) {
    linesBox.appendChild(makeLine(n++, 'no experiments recorded', 'dim'));
  } else {
    for (const experiment of experiments.slice(0, 5)) {
      const experimentLine = makeLine(n++, `◇ [${experiment.status}] ${experiment.title}`);
      makeInteractiveLine(experimentLine, () => openMemoryItemWindow('experiment', experiment, project));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'inline-delete';
      remove.textContent = '×';
      remove.title = 'delete experiment';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm(`delete experiment “${experiment.title}”?`)) return;
        await window.journal.deleteExperiment(experiment.id);
        await renderProjectWindowContent(win, project);
      });
      experimentLine.appendChild(remove);
      linesBox.appendChild(experimentLine);
      if (experiment.hypothesis) linesBox.appendChild(makeLine(n++, `  hypothesis: ${experiment.hypothesis}`, 'dim'));
      if (experiment.conclusion) linesBox.appendChild(makeLine(n++, `  conclusion: ${experiment.conclusion}`, experiment.status === 'failed' ? 'possible' : 'dim'));
    }
  }

  const insightCount = insights.decisionDebt.length + insights.explicitConflicts.length;
  if (insightCount > 0) {
    linesBox.appendChild(makeLine(n++, ''));
    linesBox.appendChild(makeLine(n++, '[ EDI CONTEXT ]', 'accent section-heading'));
    for (const debt of insights.decisionDebt.slice(0, 3)) {
      linesBox.appendChild(makeLine(n++, `temporary decision: ${debt.title} · ${debt.detail || 'review pending'}`, 'decision-debt'));
    }
    for (const conflict of insights.explicitConflicts.slice(0, 3)) {
      linesBox.appendChild(makeLine(n++, `assumption ${conflict.status}: ${conflict.detail} · used by ${conflict.title}`, 'possible'));
    }
  }
  const toolbar = document.createElement('div');
  toolbar.className = 'dj-row app-toolbar';
  toolbar.style.marginBottom = '6px';
  toolbar.innerHTML = `
    <button id="refresh-git-btn" class="button-secondary" type="button">refresh git</button>
    <button id="open-xray-btn" class="button-secondary" type="button">x-ray</button>
    <span id="git-status-label" class="dim"></span>
  `;
  container.insertBefore(toolbar, linesBox);

  const form = document.createElement('div');
  form.className = 'dj-form';
  form.innerHTML = `
    <input id="new-entry-title" type="text" placeholder="note title" />
    <textarea id="new-entry-context" rows="2" placeholder="context / problem"></textarea>
    <textarea id="new-entry-decision" rows="3" placeholder="what changed / what did you learn?"></textarea>
    <details class="advanced-fields">
      <summary>details and relationships</summary>
      <textarea id="new-entry-alternatives" rows="2" placeholder="alternatives considered"></textarea>
      <textarea id="new-entry-outcome" rows="2" placeholder="result / follow-up"></textarea>
      <input id="new-entry-tags" type="text" placeholder="tags, comma-separated" />
      <input id="new-entry-commits" type="text" placeholder="commit hashes, comma-separated" value="${escapeHtml(project.lastHeadHash ?? '')}" />
    </details>
    <button id="new-entry-btn" class="button-primary" type="button">save note</button>
  `;

  const status = document.createElement('div');
  status.className = 'dj-status';
  status.style.marginTop = '6px';
  status.style.color = '#8f8';
  status.textContent = '';

  form.appendChild(status);
  win.setContent(container);
  keepVisualLineNumbers(win, linesBox);

  const refreshButton = toolbar.querySelector('#refresh-git-btn');
  const xrayButton = toolbar.querySelector('#open-xray-btn');
  const gitStatusLabel = toolbar.querySelector('#git-status-label');

  xrayButton.addEventListener('click', () => openXrayWindow(project));

  refreshButton.addEventListener('click', async () => {
    gitStatusLabel.textContent = 'refreshing...';
    try {
      const metadata = await window.journal.refreshGitMetadata({
        projectId: project.id,
      });
      gitStatusLabel.textContent = metadata.status.summary;
      gitStatusLabel.textContent = 'git refreshed.';
      await renderProjectWindowContent(win, project);
    } catch (error) {
      gitStatusLabel.textContent = `refresh failed: ${error?.message ?? error}`;
      console.error('refresh git metadata failed', error);
    }
  });

  form.querySelector('#new-entry-btn').addEventListener('click', async () => {
    const titleInput = form.querySelector('#new-entry-title');
    const title = titleInput.value.trim();
    const fieldIds = [
      ['context', '#new-entry-context'],
      ['decision', '#new-entry-decision'],
      ['alternatives', '#new-entry-alternatives'],
      ['outcome', '#new-entry-outcome'],
    ];
    const bodyMd = fieldIds
      .map(([heading, inputId]) => [heading, form.querySelector(inputId).value.trim()])
      .filter(([, value]) => value)
      .map(([heading, value]) => `## ${heading}\n\n${value}`)
      .join('\n\n');
    status.textContent = '';
    if (!title) {
      status.style.color = '#f88';
      status.textContent = 'enter a title for the entry.';
      return;
    }

    try {
      await window.journal.createEntry({
        projectId: project.id,
        title,
        bodyMd,
        tags: form.querySelector('#new-entry-tags').value.split(','),
        commitHashes: form.querySelector('#new-entry-commits').value.split(','),
      });
      titleInput.value = '';
      for (const [, inputId] of fieldIds) form.querySelector(inputId).value = '';
      form.querySelector('#new-entry-tags').value = '';
      status.style.color = '#8f8';
      status.textContent = 'entry saved.';
      await renderProjectWindowContent(win, project);
    } catch (error) {
      status.style.color = '#f88';
      status.textContent = `failed to save entry: ${error?.message ?? error}`;
      console.error('entry create failed', error);
    }
  });

  const checkpointForm = document.createElement('div');
  checkpointForm.className = 'dj-form';
  checkpointForm.innerHTML = `
    <input id="checkpoint-title" type="text" placeholder="save-state title" />
    <textarea id="checkpoint-working-on" rows="2" placeholder="what I was working on"></textarea>
    <textarea id="checkpoint-works" rows="2" placeholder="what currently works"></textarea>
    <textarea id="checkpoint-broken" rows="2" placeholder="what is broken or unfinished"></textarea>
    <textarea id="checkpoint-next" rows="2" placeholder="next likely step"></textarea>
    <details class="advanced-fields">
      <summary>more context and relationships</summary>
      <textarea id="checkpoint-understanding" rows="2" placeholder="what I was trying to understand"></textarea>
      <textarea id="checkpoint-decisions" rows="2" placeholder="important decisions made"></textarea>
      <textarea id="checkpoint-rejected" rows="2" placeholder="alternatives rejected and why"></textarea>
      <textarea id="checkpoint-questions" rows="2" placeholder="open questions / unfinished thoughts"></textarea>
      <textarea id="checkpoint-note" rows="2" placeholder="additional notes"></textarea>
      <input id="checkpoint-commits" type="text" placeholder="commit hashes, comma-separated" value="${escapeHtml(project.lastHeadHash ?? '')}" />
      <input id="checkpoint-files" type="text" placeholder="related files, comma-separated" />
      <label class="field-label">related notes<select id="checkpoint-entries" multiple size="3"></select></label>
      <label class="field-label">related research<select id="checkpoint-research" multiple size="3"></select></label>
    </details>
    <button id="checkpoint-btn" class="button-primary" type="button">save checkpoint</button>
    <div class="dj-status"></div>
  `;
  const checkpointEntries = checkpointForm.querySelector('#checkpoint-entries');
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.title;
    checkpointEntries.appendChild(option);
  }
  const checkpointResearch = checkpointForm.querySelector('#checkpoint-research');
  for (const item of research) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.title;
    checkpointResearch.appendChild(option);
  }
  checkpointForm.querySelector('#checkpoint-btn').addEventListener('click', async () => {
    const checkpointStatus = checkpointForm.querySelector('.dj-status');
    const title = checkpointForm.querySelector('#checkpoint-title').value.trim();
    if (!title) {
      checkpointStatus.textContent = 'enter a checkpoint title.';
      return;
    }
    try {
      await window.journal.createCheckpoint({
        projectId: project.id,
        title,
        note: checkpointForm.querySelector('#checkpoint-note').value.trim(),
        workingOn: checkpointForm.querySelector('#checkpoint-working-on').value.trim(),
        currentWorks: checkpointForm.querySelector('#checkpoint-works').value.trim(),
        brokenOrUnfinished: checkpointForm.querySelector('#checkpoint-broken').value.trim(),
        tryingToUnderstand: checkpointForm.querySelector('#checkpoint-understanding').value.trim(),
        decisionsMade: checkpointForm.querySelector('#checkpoint-decisions').value.trim(),
        alternativesRejected: checkpointForm.querySelector('#checkpoint-rejected').value.trim(),
        openQuestions: checkpointForm.querySelector('#checkpoint-questions').value.trim(),
        nextStep: checkpointForm.querySelector('#checkpoint-next').value.trim(),
        commitHashes: checkpointForm.querySelector('#checkpoint-commits').value.split(','),
        filePaths: checkpointForm.querySelector('#checkpoint-files').value.split(','),
        entryIds: [...checkpointEntries.selectedOptions].map((option) => option.value),
        researchIds: [...checkpointResearch.selectedOptions].map((option) => option.value),
      });
      for (const input of checkpointForm.querySelectorAll('input:not(#checkpoint-commits), textarea')) input.value = '';
      for (const option of checkpointForm.querySelectorAll('select option')) option.selected = false;
      checkpointStatus.textContent = 'checkpoint saved.';
      await renderProjectWindowContent(win, project);
    } catch (error) {
      checkpointStatus.textContent = `failed to create checkpoint: ${error?.message ?? error}`;
    }
  });

  const researchForm = document.createElement('div');
  researchForm.className = 'dj-form';
  researchForm.innerHTML = `
    <select id="research-type">
      <option value="link">link</option>
      <option value="pdf">pdf</option>
      <option value="image">image</option>
      <option value="video">video</option>
      <option value="note">note</option>
    </select>
    <input id="research-title" type="text" placeholder="research title" />
    <div class="dj-row media-location-row">
      <input id="research-location" type="text" placeholder="path or URL" />
      <button id="research-browse" class="button-secondary" type="button">browse</button>
    </div>
    <div id="research-preview"></div>
    <textarea id="research-notes" rows="3" placeholder="what did this teach you?"></textarea>
    <label class="field-label">related notes<select id="research-entries" multiple size="3"></select></label>
    <button id="research-btn" class="button-primary" type="button">save research</button>
    <div class="dj-status"></div>
  `;
  const researchType = researchForm.querySelector('#research-type');
  const researchTitle = researchForm.querySelector('#research-title');
  const researchLocation = researchForm.querySelector('#research-location');
  const researchPreview = researchForm.querySelector('#research-preview');
  const updateResearchPreview = () => {
    researchPreview.innerHTML = '';
    const location = researchLocation.value.trim();
    if (location) researchPreview.appendChild(createMediaPreview(researchType.value, location, true));
  };
  researchType.addEventListener('change', updateResearchPreview);
  researchLocation.addEventListener('change', updateResearchPreview);
  researchLocation.addEventListener('paste', () => window.setTimeout(updateResearchPreview, 0));
  researchForm.querySelector('#research-browse').addEventListener('click', async () => {
    const selected = await window.journal.chooseMediaFile(researchType.value);
    if (!selected) return;
    researchLocation.value = selected;
    researchType.value = mediaTypeForLocation(selected, researchType.value);
    if (!researchTitle.value.trim()) {
      researchTitle.value = mediaFileName(selected).replace(/\.[^.]+$/, '');
    }
    updateResearchPreview();
  });
  const researchEntries = researchForm.querySelector('#research-entries');
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.title;
    researchEntries.appendChild(option);
  }
  researchForm.querySelector('#research-btn').addEventListener('click', async () => {
    const researchStatus = researchForm.querySelector('.dj-status');
    const title = researchTitle.value.trim();
    if (!title) {
      researchStatus.textContent = 'enter a research title.';
      return;
    }
    try {
      const location = researchLocation.value.trim();
      await window.journal.createResearchItem({
        projectId: project.id,
        type: researchType.value,
        title,
        pathOrUrl: location || null,
        notes: researchForm.querySelector('#research-notes').value.trim(),
        entryIds: [...researchEntries.selectedOptions].map((option) => option.value),
      });
      researchTitle.value = '';
      researchLocation.value = '';
      researchForm.querySelector('#research-notes').value = '';
      researchPreview.innerHTML = '';
      for (const option of researchEntries.options) option.selected = false;
      researchStatus.textContent = location && !/^(https?:|data:|blob:)/i.test(location)
        ? 'research saved. media copied inside the journal.'
        : 'research saved.';
      await renderProjectWindowContent(win, project);
    } catch (error) {
      researchStatus.textContent = `failed to save research: ${error?.message ?? error}`;
    }
  });

  mountCompanionWindow(project, 'note', 'ADD NOTE', form);
  mountCompanionWindow(project, 'checkpoint', 'CHECKPOINT', checkpointForm);
  mountCompanionWindow(project, 'research', 'RESEARCH', researchForm);
  mountCompanionWindow(project, 'experiment', 'EXPERIMENT', createExperimentForm(project, win, entries, research, decisions, assumptions), true);
  await openDecisionsWindow(project);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

buildProjectsWindow();
