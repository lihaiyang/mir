/**
 * 用户脚本（油猴脚本 / userscript）的共享契约。
 *
 * 三边共用，避免各写一份字段名：
 *  - 主进程（src/main/userscripts.ts）：文件落盘、元数据解析、URL 匹配、GM 存储、GM_xmlhttpRequest 转发
 *  - 预加载脚本（src/preload/webview.ts）：按主进程下发的匹配结果在内嵌浏览器主世界注入
 *  - 渲染器（设置界面 / 浏览器工具栏）：列表、导入、启停、编辑、脚本菜单
 *
 * 落盘布局（userData/userscripts）：
 *   <id>.user.js         脚本原文（含 ==UserScript== 元数据块）
 *   cache/<sha1>.<ext>   @require / @resource 下载缓存
 *   values/<id>.json     GM_setValue 的键值快照
 *
 * 注入链路：
 *   webview preload 启动（早于页面任何脚本）→ ipcRenderer.sendSync(USERSCRIPT_CHANNELS.forUrl, url)
 *   → 主进程按 @match/@include/@exclude 过滤、内联 @require 代码、带上 GM 值快照
 *   → preload 用 webFrame.executeJavaScript 注入到页面主世界（GM_* 通过 contextBridge 桥接回来）
 */

/** 注入时机，对应油猴的 @run-at */
export type UserScriptRunAt = 'document-start' | 'document-end' | 'document-idle'

/** 油猴默认 @run-at 是 document-idle；这里与主流实现保持一致 */
export const DEFAULT_RUN_AT: UserScriptRunAt = 'document-idle'

export const USERSCRIPT_RUN_AT_VALUES: readonly UserScriptRunAt[] = [
  'document-start',
  'document-end',
  'document-idle'
]

/** @resource 声明的资源：name 供 GM_getResourceText/GM_getResourceURL 使用 */
export interface UserScriptResourceRef {
  name: string
  url: string
}

/** 解析出的 ==UserScript== 元数据 */
export interface UserScriptMeta {
  name: string
  namespace: string
  version: string
  description: string
  author: string
  /** @match（Chrome match pattern）/ @include（glob 或 match pattern），任一命中即注入 */
  matches: string[]
  includes: string[]
  /** @exclude 优先于 @match/@include */
  excludes: string[]
  runAt: UserScriptRunAt
  /** @grant 声明；空数组等同于 @grant none（直接在页面上下文跑，不提供 GM_*） */
  grants: string[]
  requires: string[]
  resources: UserScriptResourceRef[]
  /** @noframes：内嵌 iframe 不注入（MIR 里 webview 只注入顶层文档，故此标记仅作记录） */
  noframes: boolean
  icon?: string
  /** 未识别的 @key，原样保留，便于排查与后续扩展 */
  extra: Record<string, string[]>
}

/** 列表项（不含脚本正文，设置界面列表用） */
export interface UserScriptSummary {
  /** 由 @namespace + @name 派生的稳定 id（重装同名脚本会覆盖同一条记录） */
  id: string
  enabled: boolean
  /** 脚本文件绝对路径 */
  file: string
  meta: UserScriptMeta
  /** 字节数 */
  size: number
  /** 文件 mtime（毫秒） */
  mtime: number
  /** @require / @resource 缓存失败原因；null 表示缓存就绪 */
  cacheError: string | null
}

/** 详情（多带一份脚本原文，编辑用） */
export interface UserScriptDetail extends UserScriptSummary {
  source: string
}

/** GM_info 的静态快照 */
export interface UserScriptInfoSnapshot {
  script: {
    name: string
    namespace: string
    version: string
    description: string
    author: string
    matches: string[]
    grants: string[]
    runAt: UserScriptRunAt
  }
  scriptHandler: string
  version: string
  scriptMetaStr: string
}

/** 主进程下发给 preload 的一份可注入脚本 */
export interface UserScriptInjection {
  id: string
  name: string
  runAt: UserScriptRunAt
  grants: string[]
  /** @require 内容已按声明顺序内联拼装（空字符串表示没有 @require） */
  requireCode: string
  /** 脚本正文，已剔除元数据块 */
  code: string
  /** @resource 文本内容：name -> 内容 */
  resources: Record<string, string>
  info: UserScriptInfoSnapshot
}

/** 一次导航的注入快照（forUrl 同步 IPC 的返回值） */
export interface UserScriptsForUrlPayload {
  url: string
  scripts: UserScriptInjection[]
  /** scriptId -> { key: value }，GM_getValue 的本地镜像来源 */
  values: Record<string, Record<string, unknown>>
}

/** GM_xmlhttpRequest 请求（渲染侧的子集，够跑绝大多数脚本） */
export interface GmXhrRequest {
  method?: string
  url: string
  headers?: Record<string, string>
  data?: string
  timeout?: number
  responseType?: 'text' | 'json' | 'arraybuffer'
  /** 不携带该 session 的 Cookie */
  anonymous?: boolean
}

/** GM_xmlhttpRequest 回执；二进制走 base64 */
export interface GmXhrResponse {
  ok: boolean
  status: number
  statusText: string
  /** 原始响应头文本（KEY: VALUE\r\n...），GM 的 responseHeaders 就是这个格式 */
  responseHeaders: string
  finalUrl: string
  /** responseType=arraybuffer 时为 base64，其余为文本 */
  responseText: string
  error?: string
}

/** 脚本通过 GM_registerMenuCommand 注册的菜单项（宿主浏览器工具栏展示） */
export interface UserScriptMenuCommand {
  /** 脚本内的命令 id，点击时原样回传给脚本回调 */
  id: string | number
  title: string
  scriptId: string
  scriptName: string
}

/** webview preload → 宿主渲染进程的通道（走 ipcRenderer.sendToHost） */
export const USERSCRIPT_HOST_CHANNEL = 'userscripts:host'

/** 宿主渲染进程里 webview 收到的 ipc-message 子类型 */
export type UserScriptHostMessage =
  | { type: 'menu'; commands: UserScriptMenuCommand[] }
  | { type: 'log'; scriptId: string; message: string }

/** 主进程 IPC 通道名 */
export const USERSCRIPT_CHANNELS = {
  /** 列表：() => UserScriptSummary[] */
  list: 'userscripts:list',
  /** 详情：id => UserScriptDetail | null */
  detail: 'userscripts:detail',
  /** 导入：{ source, filename? } => UserScriptSummary（解析失败抛错） */
  install: 'userscripts:install',
  /** 从磁盘选择 .user.js 导入（弹系统文件选择框）：() => UserScriptSummary[] */
  installFromFile: 'userscripts:install-from-file',
  /** 保存原文（编辑）：{ id, source } => UserScriptSummary */
  save: 'userscripts:save',
  /** 删除：id => void */
  remove: 'userscripts:remove',
  /** 启停：{ id, enabled } => UserScriptSummary */
  setEnabled: 'userscripts:set-enabled',
  /** 在系统文件管理器中打开脚本目录：() => void */
  openDir: 'userscripts:open-dir',
  /** 重新扫描目录（外部编辑器改过文件时）：() => UserScriptSummary[] */
  rescan: 'userscripts:rescan',
  /** 重新下载 @require / @resource：id => UserScriptSummary */
  refreshCache: 'userscripts:refresh-cache',
  /** 同步查询某 URL 该注入哪些脚本：url => UserScriptsForUrlPayload */
  forUrl: 'userscripts:for-url',
  /** 持久化 GM 值：{ scriptId, key, value } => void */
  gmSet: 'userscripts:gm-set',
  /** 删除 GM 值：{ scriptId, key } => void */
  gmDelete: 'userscripts:gm-delete',
  /** 代理跨域请求：GmXhrRequest => GmXhrResponse */
  xhr: 'userscripts:xhr',
  /** 脚本里 GM_openInTab：{ url, active } => void */
  openInTab: 'userscripts:open-in-tab',
  /** 脚本里 GM_notification（简化实现，走系统通知）：{ title, text } => void */
  notify: 'userscripts:notify'
} as const

/** 默认提供的 GM_* 名字（unsafeWindow 走 window，单独处理） */
export const KNOWN_GRANTS: readonly string[] = [
  'GM_setValue',
  'GM_getValue',
  'GM_deleteValue',
  'GM_listValues',
  'GM_addValueChangeListener',
  'GM_removeValueChangeListener',
  'GM_addStyle',
  'GM_addElement',
  'GM_xmlhttpRequest',
  'GM_registerMenuCommand',
  'GM_unregisterMenuCommand',
  'GM_getResourceText',
  'GM_getResourceURL',
  'GM_notification',
  'GM_openInTab',
  'GM_setClipboard',
  'GM_log',
  'GM_info',
  'unsafeWindow'
]
