let zCounter = 10;
const registry = new Map();
const connections = new Map();
const dockItems = new Map();
let connectionLayer;
let windowDock;
let connectionFrame;

function ensureWindowDock() {
  if (windowDock) return windowDock;
  windowDock = document.createElement('div');
  windowDock.className = 'window-dock';
  windowDock.setAttribute('aria-label', 'hidden windows');
  document.getElementById('windows-layer').appendChild(windowDock);
  return windowDock;
}

function addDockItem(win) {
  const dock = ensureWindowDock();
  const existing = [...dock.querySelectorAll('button')].find((item) => item.dataset.windowId === win.id);
  if (existing) {
    existing.textContent = win.dockLabel || win.title;
    existing.title = `restore ${win.dockLabel || win.title}`;
    dockItems.set(win.id, existing);
    return;
  }
  dockItems.get(win.id)?.remove();
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.windowId = win.id;
  button.textContent = win.dockLabel || win.title;
  button.title = `restore ${win.dockLabel || win.title}`;
  button.addEventListener('click', () => win.show());
  dock.appendChild(button);
  dockItems.set(win.id, button);
}

function removeDockItem(id) {
  dockItems.get(id)?.remove();
  dockItems.delete(id);
  if (!windowDock) return;
  for (const button of windowDock.querySelectorAll('button')) {
    if (button.dataset.windowId === id) button.remove();
  }
}

function ensureConnectionLayer() {
  if (connectionLayer) return connectionLayer;
  connectionLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  connectionLayer.classList.add('connection-layer');
  connectionLayer.setAttribute('aria-hidden', 'true');
  document.getElementById('windows-layer').prepend(connectionLayer);
  return connectionLayer;
}

function connectionPoint(fromRect, toRect) {
  const fromCenter = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
  const toCenter = { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      x: dx >= 0 ? fromRect.right : fromRect.left,
      y: fromCenter.y,
    };
  }
  return {
    x: fromCenter.x,
    y: dy >= 0 ? fromRect.bottom : fromRect.top,
  };
}

function updateConnections() {
  connectionFrame = null;
  for (const connection of connections.values()) {
    const from = registry.get(connection.fromId);
    const to = registry.get(connection.toId);
    if (!from || !to) continue;
    connection.path.style.display = from.isHidden || to.isHidden ? 'none' : '';
    if (from.isHidden || to.isHidden) continue;
    const fromRect = from.el.getBoundingClientRect();
    const toRect = to.el.getBoundingClientRect();
    const start = connectionPoint(fromRect, toRect);
    const end = connectionPoint(toRect, fromRect);
    const dx = Math.max(50, Math.abs(end.x - start.x) * 0.45);
    const direction = end.x >= start.x ? 1 : -1;
    connection.path.setAttribute('d', `M ${start.x} ${start.y} C ${start.x + dx * direction} ${start.y}, ${end.x - dx * direction} ${end.y}, ${end.x} ${end.y}`);
  }
}

function queueConnectionUpdate() {
  if (connectionFrame) return;
  connectionFrame = window.requestAnimationFrame(updateConnections);
}

function connectWindows(fromId, toId) {
  const key = `${fromId}->${toId}`;
  if (connections.has(key)) return;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.classList.add('window-connection');
  ensureConnectionLayer().appendChild(path);
  connections.set(key, { fromId, toId, path });
  queueConnectionUpdate();
}

function removeWindowConnections(id) {
  for (const [key, connection] of connections) {
    if (connection.fromId !== id && connection.toId !== id) continue;
    connection.path.remove();
    connections.delete(key);
  }
}

class DJWindow {
  constructor({ id, title, x = 60, y = 60, width = 380, height = 460, onClose, dockable = false, dockLabel = '' }) {
    const existing = registry.get(id);
    if (existing && !existing.isDestroyed) return existing;
    this.id = id;
    this.title = title;
    this.onClose = onClose;
    this.dockable = dockable;
    this.dockLabel = dockLabel;
    this.isMaximized = false;
    this.isMinimized = false;
    this.isHidden = false;
    this.isDestroyed = false;
    this.dragCleanup = null;
    this.restoreBounds = { x, y, width, height };

    this.el = document.createElement('div');
    this.el.className = 'dj-window';
    this.el.dataset.windowId = id;
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
    this.el.style.width = width + 'px';
    this.el.style.height = height + 'px';
    this.el.style.zIndex = String(++zCounter);

    this.el.innerHTML = `
      <div class="dj-titlebar">
        <span class="dj-title">${escapeHtml(title)}</span>
        <div class="dj-controls">
          <button class="dj-btn dj-min" type="button" title="minimize" aria-label="minimize">−</button>
          <button class="dj-btn dj-max" type="button" title="maximize" aria-label="maximize">□</button>
          <button class="dj-btn dj-close" type="button" title="close" aria-label="close">×</button>
        </div>
      </div>
      <div class="dj-body"></div>
    `;

    this.bodyEl = this.el.querySelector('.dj-body');
    this.titlebarEl = this.el.querySelector('.dj-titlebar');

    this.el.addEventListener('pointerdown', () => this.bringToFront());
    this.titlebarEl.addEventListener('pointerdown', (e) => this.startDrag(e));
    this.el.querySelector('.dj-min').addEventListener('click', () => this.toggleMinimize());
    this.el.querySelector('.dj-max').addEventListener('click', () => this.toggleMaximize());
    this.el.querySelector('.dj-close').addEventListener('click', () => this.close());

    registry.set(id, this);
  }

  setContent(node) {
    this.bodyEl.innerHTML = '';
    this.bodyEl.appendChild(node);
  }

  fitContentHeight(minHeight = 260, maxHeight = window.innerHeight - 40) {
    if (this.isMaximized) return;
    const chromeHeight = this.titlebarEl.offsetHeight + 2;
    const bodyStyle = window.getComputedStyle(this.bodyEl);
    const bodyPadding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
    const contentHeight = this.bodyEl.firstElementChild?.getBoundingClientRect().height ?? 0;
    const desiredHeight = Math.ceil(chromeHeight + bodyPadding + contentHeight);
    const height = Math.min(maxHeight, Math.max(minHeight, desiredHeight));
    this.el.style.height = `${height}px`;
    this.restoreBounds.height = height;
  }

  mount(layer) {
    if (!this.isDestroyed && !this.el.isConnected) {
      layer.appendChild(this.el);
      this.keepInViewport();
    }
    return this;
  }

  keepInViewport() {
    if (this.isDestroyed || this.isMaximized) return;
    const titlebarHeight = this.titlebarEl.offsetHeight;
    const minVisibleWidth = Math.min(80, this.el.offsetWidth);
    const minX = minVisibleWidth - this.el.offsetWidth;
    const maxX = window.innerWidth - minVisibleWidth;
    const maxY = Math.max(0, window.innerHeight - titlebarHeight);
    this.el.style.left = `${Math.min(maxX, Math.max(minX, this.el.offsetLeft))}px`;
    this.el.style.top = `${Math.min(maxY, Math.max(0, this.el.offsetTop))}px`;
  }

  bringToFront() {
    if (this.isHidden) this.show();
    this.el.style.zIndex = String(++zCounter);
  }

  hide() {
    if (this.isDestroyed || this.isHidden) return;
    this.isHidden = true;
    this.el.classList.add('docked');
    addDockItem(this);
    queueConnectionUpdate();
  }

  show() {
    if (this.isDestroyed) return;
    if (!this.isHidden) {
      removeDockItem(this.id);
      this.bringToFront();
      return;
    }
    this.isHidden = false;
    this.el.classList.remove('docked');
    removeDockItem(this.id);
    this.bringToFront();
    queueConnectionUpdate();
  }

  startDrag(e) {
    if (e.button !== 0 || e.target.closest('.dj-btn') || this.isMaximized) return;
    e.preventDefault();
    this.dragCleanup?.();

    const startX = e.clientX;
    const startY = e.clientY;
    const originX = this.el.offsetLeft;
    const originY = this.el.offsetTop;
    const pointerId = e.pointerId;
    this.titlebarEl.setPointerCapture?.(pointerId);

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const titlebarHeight = this.titlebarEl.offsetHeight;
      const minVisibleWidth = Math.min(80, this.el.offsetWidth);
      const nextX = originX + (ev.clientX - startX);
      const nextY = originY + (ev.clientY - startY);
      const minX = minVisibleWidth - this.el.offsetWidth;
      const maxX = window.innerWidth - minVisibleWidth;
      const maxY = Math.max(0, window.innerHeight - titlebarHeight);
      this.el.style.left = `${Math.min(maxX, Math.max(minX, nextX))}px`;
      this.el.style.top = `${Math.min(maxY, Math.max(0, nextY))}px`;
      queueConnectionUpdate();
    };

    const cleanup = () => {
      this.titlebarEl.removeEventListener('pointermove', onMove);
      this.titlebarEl.removeEventListener('pointerup', onEnd);
      this.titlebarEl.removeEventListener('pointercancel', onEnd);
      this.titlebarEl.removeEventListener('lostpointercapture', onEnd);
      if (this.titlebarEl.hasPointerCapture?.(pointerId)) {
        this.titlebarEl.releasePointerCapture(pointerId);
      }
      if (this.dragCleanup === cleanup) this.dragCleanup = null;
    };
    const onEnd = (ev) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    };
    this.dragCleanup = cleanup;
    this.titlebarEl.addEventListener('pointermove', onMove);
    this.titlebarEl.addEventListener('pointerup', onEnd);
    this.titlebarEl.addEventListener('pointercancel', onEnd);
    this.titlebarEl.addEventListener('lostpointercapture', onEnd);
  }

  toggleMinimize() {
    if (this.dockable) {
      this.hide();
      return;
    }
    this.isMinimized = !this.isMinimized;
    this.el.classList.toggle('minimized', this.isMinimized);
    queueConnectionUpdate();
  }

  toggleMaximize() {
    if (!this.isMaximized) {
      this.restoreBounds = {
        x: this.el.offsetLeft,
        y: this.el.offsetTop,
        width: this.el.offsetWidth,
        height: this.el.offsetHeight,
      };
      this.el.style.left = '16px';
      this.el.style.top = '16px';
      this.el.style.width = 'calc(100vw - 32px)';
      this.el.style.height = 'calc(100vh - 32px)';
      this.isMaximized = true;
    } else {
      const b = this.restoreBounds;
      this.el.style.left = b.x + 'px';
      this.el.style.top = b.y + 'px';
      this.el.style.width = b.width + 'px';
      this.el.style.height = b.height + 'px';
      this.isMaximized = false;
    }
    queueConnectionUpdate();
  }

  close() {
    if (this.isDestroyed) return;
    if (this.dockable) {
      this.hide();
      return;
    }
    this.destroy();
  }

  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.dragCleanup?.();
    this.lineNumberObserver?.disconnect();
    removeWindowConnections(this.id);
    removeDockItem(this.id);
    this.el.remove();
    if (registry.get(this.id) === this) registry.delete(this.id);
    if (this.onClose) this.onClose();
  }
}

function getWindow(id) {
  return registry.get(id);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

window.DJWindow = DJWindow;
window.getDJWindow = getWindow;
window.connectDJWindows = connectWindows;
window.addEventListener('resize', () => {
  for (const win of registry.values()) win.keepInViewport();
  queueConnectionUpdate();
});
