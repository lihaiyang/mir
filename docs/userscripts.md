# 用户脚本（油猴脚本）

MIR 内嵌浏览器支持用户脚本（userscript，俗称「油猴脚本」），但**不是**通过加载 Tampermonkey 扩展实现的，
而是内置了一个轻量运行器。原因：Electron 只实现了部分 `chrome.*` 扩展 API，真实扩展的安装流程、后台页和
UI 行为都很难完整跑起来，且会随 Electron / 扩展版本升级频繁失效。

内置运行器的行为与油猴对齐的是「脚本语义」，而不是「扩展 UI」：脚本仍是你熟悉的
`// ==UserScript==` 文件，仍然能拿到 `GM_*`，仍然按 `@match` / `@run-at` 生效。

## 注入链路

```
<webview> 创建
  └─ 主进程 will-attach-webview 指定 preload = out/preload/webview.js   （src/main/index.ts）
       └─ preload 在页面任何脚本之前执行
            ├─ ipcRenderer.sendSync('userscripts:for-url', location.href)   （同步：必须同事件循环返回）
            │    └─ 主进程按 @match/@include/@exclude 过滤 + 内联 @require + 带上 GM 值快照
            └─ webFrame.executeJavaScript(wrapper)  → 注入页面主世界
                 └─ GM_* 通过 contextBridge 暴露的 window.__mirUserscriptBridge 回调主进程
```

要点：

- **preload 早于页面脚本**，所以 `@run-at document-start` 能拿到干净的 DOM。
- **主进程侧全部用同步 fs**：`for-url` 是 `sendSync`，必须同一次事件循环返回。脚本都是小文本，代价可忽略。
- **注入到主世界**：`contextIsolation=yes` 下 preload 在隔离世界，`webFrame.executeJavaScript` 才是页面世界，
  脚本因此能和页面共享 `window`（和油猴一致）。
- **GM_ 值走快照**：`GM_getValue` 是同步 API，preload 在注入前已拿到整份键值快照；写操作异步回主进程落盘。

## 支持的元数据

| 指令 | 说明 |
| --- | --- |
| `@name` | 必填。与 `@namespace` 一起决定脚本 id |
| `@namespace` | 同名脚本重装会覆盖同一条记录 |
| `@version` / `@description` / `@author` | 展示用 |
| `@match` | Chrome match pattern：`<scheme>://<host><path>`，`*` 通配 scheme，`*.example.com` 通配子域 |
| `@include` | 支持 match pattern、glob，以及 `/正则/` |
| `@exclude` | 优先级高于 `@match` / `@include` |
| `@run-at` | `document-start`（含 `document-body`）/ `document-end` / `document-idle`（默认） |
| `@grant` | 未声明时按「全部开放」处理（见下方说明） |
| `@require` | 下载后在注入时内联到脚本正文之前，缓存到本地 |
| `@resource` | 下载后供 `GM_getResourceText` / `GM_getResourceURL` 使用 |
| `@noframes` | 仅记录（webview 的 preload 只作用于顶层文档） |
| 其它 `@key` | 原样保留在 `meta.extra` 里，便于排查与后续扩展 |

没有元数据块、缺 `@name`、或缺 `@match`/`@include` 的脚本会在安装时报错；从目录扫描到的坏脚本仍会出现在
列表里（带解析错误提示），方便就地修正。

## 支持的 GM API

`GM_getValue` / `GM_setValue` / `GM_deleteValue` / `GM_listValues`、
`GM_addStyle` / `GM_addElement`、
`GM_xmlhttpRequest`（主进程代理，绕 CORS，共享 `persist:browser` 的 Cookie）、
`GM_registerMenuCommand` / `GM_unregisterMenuCommand`、
`GM_getResourceText` / `GM_getResourceURL`、
`GM_notification`（走系统通知）、`GM_openInTab`（开新的浏览器标签）、
`GM_setClipboard`、`GM_info`、`GM_log`。
另外提供 `@grant GM_addValueChangeListener` / `GM_removeValueChangeListener` 的空注册（记录回调但不跨脚本广播）。

`@grant` 的处理是有意放宽的：**没有声明 `@grant` 时所有 API 都可用**。严格的油猴行为是「`@grant none`
即无 GM API」，但那会让大量随手写的脚本静默失效，对轻量运行器来说不值得。

## 脚本菜单

`GM_registerMenuCommand` 注册的菜单项由 preload 通过 `ipcRenderer.sendToHost('userscripts:host', ...)`
发给宿主；宿主在浏览器工具栏用一个闪电图标按钮展示（`BrowserTab.vue` / `BrowserPanel.vue`）。
点击时宿主让 webview 执行 `window.__mirUserScriptMenu['<scriptId>::<cmdId>']()` ——
回调本就在页面主世界，不需要再绕一次 IPC。

## 文件布局与开关

```
<userData>/userscripts/
  <id>.user.js        脚本原文
  cache/<sha1>.<ext>  @require / @resource 下载缓存
  values/<id>.json    GM_setValue 的键值快照
```

`id = sha1(namespace + "\0" + name)` 前 16 位。启停状态存在 `electron-store` 的
`userscripts.disabledIds`（脚本文件不会被移动，所以外部编辑器改文件后重新扫描仍能保留开关状态）。

## 已知限制

- 不支持 `unsafeWindow` 之外的沙箱隔离：脚本与页面共享主世界，一个抛错不会影响其它脚本（各自 try/catch），
  但脚本之间可见彼此的 `window` 改动。
- 不支持 `@updateURL` / `@downloadURL` 的自动更新，升级靠重新导入。
- `GM_setClipboard` 在主世界走 `navigator.clipboard`，无权限时降级为 `document.execCommand('copy')`。
- 脚本菜单项需要宿主窗口处于打开状态的浏览器标签里才可见；独立（standalone）浏览器标签的工具栏在
  `TitleBar.vue`，目前只在标签内工具栏提供菜单入口。
