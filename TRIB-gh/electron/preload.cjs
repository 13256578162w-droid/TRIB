// 渲染进程可用的安全 API（CommonJS）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trib", {
  info: function () { return ipcRenderer.invoke("app:info"); },
  config: {
    get: function () { return ipcRenderer.invoke("config:get"); },
    set: function (cfg) { return ipcRenderer.invoke("config:set", cfg); },
  },
  versionDetail: function (id) { return ipcRenderer.invoke("version:detail", { id: id }); },
  launchers: function () { return ipcRenderer.invoke("launchers"); },
  precheck: function (arg) { return ipcRenderer.invoke("precheck", arg); },
  versions: {
    list: function (opts) { return ipcRenderer.invoke("versions:list", opts || {}); },
    install: function (opts) { return ipcRenderer.invoke("versions:install", opts); },
  },
  loader: {
    list: function (loader, mc) { return ipcRenderer.invoke("loader:list", { loader: loader, mc: mc }); },
    install: function (mc, loader) { return ipcRenderer.invoke("loader:install", { mc: mc, loader: loader }); },
  },
  installed: {
    scan: function () { return ipcRenderer.invoke("installed:scan"); },
    check: function (id) { return ipcRenderer.invoke("installed:check", { id: id }); },
    repair: function (id) { return ipcRenderer.invoke("installed:repair", { id: id }); },
    remove: function (id) { return ipcRenderer.invoke("installed:delete", { id: id }); },
    open: function (id) { return ipcRenderer.invoke("installed:open", { id: id }); },
  },
  cancel: function () { return ipcRenderer.invoke("install:cancel"); },
  copy: function (text) { return ipcRenderer.invoke("clipboard:write", text); },
  announce: function () { return ipcRenderer.invoke("announce:get"); },
  dir: { pick: function () { return ipcRenderer.invoke("dir:pick"); } },
  openLog: function () { return ipcRenderer.invoke("log:open"); },
  on: function (channel, cb) {
    const wrapped = function (_e, payload) { cb(payload); };
    ipcRenderer.on(channel, wrapped);
    return function () { ipcRenderer.removeListener(channel, wrapped); };
  },
});