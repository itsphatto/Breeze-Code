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
  term: {
    cwd: () => invoke('term:cwd'),
    run: command => invoke('term:run', command),
    kill: id => invoke('term:kill', id),
    onData: cb => listen('term:data', cb),
    onExit: cb => listen('term:exit', cb),
  },
  sys: {
    detect: () => invoke('sys:detect'),
    openExternal: url => invoke('sys:openExternal', url),
  },
  gemini: {
    status: () => invoke('gemini:status'),
    setKey: key => invoke('gemini:setKey', key),
    clearKey: () => invoke('gemini:clearKey'),
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
    start: provider => invoke('auth:start', provider),
    cancel: () => invoke('auth:cancel'),
    signOut: () => invoke('auth:signOut'),
    onEvent: cb => listen('auth:event', cb),
  },
  win: {
    reload: () => invoke('win:reload'),
    toggleDevTools: () => invoke('win:devtools'),
    quit: () => invoke('win:quit'),
    edit: role => invoke('win:edit', role),
  },
});
