// Exposes a narrow, typed bridge to the renderer. Every path is project-relative and checked in main.js.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const listen = (ch, cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('breeze', {
  fs: {
    openFolder: () => invoke('fs:openFolder'),
    createFolder: () => invoke('fs:createFolder'),
    restore: () => invoke('fs:restore'),
    closeFolder: () => invoke('fs:closeFolder'),
    recent: () => invoke('fs:recent'),
    openRecent: dir => invoke('fs:openRecent', dir),
    readDir: rel => invoke('fs:readDir', rel),
    readFile: rel => invoke('fs:readFile', rel),
    writeFile: (rel, text) => invoke('fs:writeFile', rel, text),
    createFile: rel => invoke('fs:createFile', rel),
    createDir: rel => invoke('fs:createDir', rel),
    rename: (from, to) => invoke('fs:rename', from, to),
    trash: rel => invoke('fs:trash', rel),
    listFiles: () => invoke('fs:listFiles'),
    search: (query, matchCase) => invoke('fs:search', query, matchCase),
    fileUrl: rel => invoke('fs:fileUrl', rel),
    onChange: cb => listen('fs:changed', cb),
  },
  lint: {
    check: (code, ext) => invoke('lint:check', code, ext),
  },
  term: {
    cwd: () => invoke('term:cwd'),
    run: command => invoke('term:run', command),
    kill: id => invoke('term:kill', id),
    complete: word => invoke('term:complete', word),
    onData: cb => listen('term:data', cb),
    onExit: cb => listen('term:exit', cb),
  },
  sys: {
    detect: () => invoke('sys:detect'),
    openExternal: url => invoke('sys:openExternal', url),
  },
  llm: {
    connect: (url, key) => invoke('llm:connect', url, key),
    setModel: model => invoke('llm:setModel', model),
    disconnect: () => invoke('llm:disconnect'),
  },
  agent: {
    run: opts => invoke('agent:run', opts),
    stop: runId => invoke('agent:stop', runId),
    openApp: id => invoke('agent:openApp', id),
    onEvent: cb => listen('agent:event', cb),
  },
  git: {
    status: () => invoke('git:status'),
    log: () => invoke('git:log'),
    show: hash => invoke('git:show', hash),
    diff: (rel, staged) => invoke('git:diff', rel, staged),
    init: () => invoke('git:init'),
    stage: paths => invoke('git:stage', paths),
    unstage: (paths, hasCommits) => invoke('git:unstage', paths, hasCommits),
    discard: files => invoke('git:discard', files),
    commit: (message, all) => invoke('git:commit', message, all),
    branches: () => invoke('git:branches'),
    switchTo: (name, create, from) => invoke('git:switch', name, create, from),
    sync: op => invoke('git:sync', op),
  },
  auth: {
    user: () => invoke('auth:user'),
    accounts: () => invoke('auth:accounts'),
    switchTo: id => invoke('auth:switch', id),
    start: provider => invoke('auth:start', provider),
    cancel: () => invoke('auth:cancel'),
    signOut: () => invoke('auth:signOut'),
    onEvent: cb => listen('auth:event', cb),
  },
  vibe: {
    status: () => invoke('vibe:status'),
    connect: id => invoke('vibe:connect', id),
    disconnect: id => invoke('vibe:disconnect', id),
    show: (id, bounds) => invoke('vibe:show', id, bounds),
    bounds: bounds => invoke('vibe:bounds', bounds),
    mute: muted => invoke('vibe:mute', muted),
    hide: () => invoke('vibe:hide'),
  },
  win: {
    reload: () => invoke('win:reload'),
    toggleDevTools: () => invoke('win:devtools'),
    quit: () => invoke('win:quit'),
    edit: role => invoke('win:edit', role),
  },
});
