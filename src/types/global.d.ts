// 全局声明：主进程/渲染层/preload 通过 contextBridge 或 AMD loader 注入的全局。
// 路线甲阶段只做「名称可解析」，签名先用 any，A3 负责把 electronAPI 细化。

declare function logInfo(...args: unknown[]): void;
declare function logWarn(...args: unknown[]): void;
declare function logError(...args: unknown[]): void;
declare function logwarn(...args: unknown[]): void;
declare function logerror(...args: unknown[]): void;

// Monaco 全局（AMD loader 注入）的类型见 src/types/monaco-umd.d.ts
// 渲染层 manager 单例：类在各文件顶层声明，本身就是全局，无需 ambient declare
// 主进程 require 由 @types/node 全局声明接管（electron 的 /// <reference types="node" /> 引入）
// 注：删掉此行会让 @types/node 合并进 Window.require 的 Require 形状激活（cache/extensions/main/resolve 必填），
// 渲染层自定义 require loader（只认 'electron'）无法满足 → TS2322。精确类型化待 .ts 阶段（require → import）。

interface OicppVarData {
  name?: string;
  type?: string;
  value?: string;
  expression?: string;
  backendName?: string;
  varObjectName?: string;
  chunkSize?: number;
  elementCount?: number;
  numchild?: string | number;
  canExpand?: boolean;
  isPlaceholder?: boolean;
  children?: OicppVarData[];
  [key: string]: unknown;
}

interface HTMLDivElement {
  __variableData?: OicppVarData;
  __oicppFile?: unknown;
}

interface HTMLElement {
  __oicppFile?: unknown;
  __oicppFileTreeEventsBound?: boolean;
  __oicppDragAndDropBound?: boolean;
  hasGlobalWheelZoomListener?: boolean;
  hasWheelZoomListener?: boolean;
  _wheelZoomHooked?: boolean;
  _input?: HTMLInputElement;
  _list?: HTMLDivElement;
  __hideTimer?: NodeJS.Timeout;
}



interface Window {
  logInfo: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
  logError: (...args: unknown[]) => void;
  logwarn: (...args: unknown[]) => void;
  logerror: (...args: unknown[]) => void;
  monaco: typeof import('monaco-editor');
  require: NodeRequire & { __electronHelper?: boolean };
  i18n: {
    t: (key: string, params?: Record<string, unknown>) => string;
    init: () => Promise<void>;
    onChange: (callback: (lang: string) => void) => () => void;
    getCurrentLanguage: () => string;
    _applyToDOM: () => void;
    enableAutoTranslate: () => void;
    setLanguage: (langCode: string) => Promise<void>;
    getAvailableLanguages: () => Promise<Array<{ code: string; name: string; nameEn: string }>>;
  };
  electronIPC: {
    send: (channel: string, ...args: unknown[]) => void;
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: never[]) => void) => void;
    once: (channel: string, listener: (...args: never[]) => void) => void;
    removeListener: (channel: string, listener: (...args: never[]) => void) => void;
    removeAllListeners: (channel: string) => void;
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (...args: never[]) => void) => void;
      once: (channel: string, listener: (...args: never[]) => void) => void;
      removeListener: (channel: string, listener: (...args: never[]) => void) => void;
      removeAllListeners: (channel: string) => void;
    };
  };
  electron: {
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (...args: never[]) => void) => void;
      once: (channel: string, listener: (...args: never[]) => void) => void;
      removeListener: (channel: string, listener: (...args: never[]) => void) => void;
      removeAllListeners: (channel: string) => void;
    };
    shell: import('electron').Shell;
  };
  markdownAPI: { render: (text: string, filePath?: string) => string };
  turndownAPI: { toMarkdown: (html: string) => string };
  getElectronModule: () => ({
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (...args: never[]) => void) => void;
      once: (channel: string, listener: (...args: never[]) => void) => void;
      removeListener: (channel: string, listener: (...args: never[]) => void) => void;
      removeAllListeners: (channel: string) => void;
    };
    shell: import('electron').Shell;
  });
  __electronRequireAvailable: boolean;
  process: {
    versions: Record<string, string>;
    platform: NodeJS.Platform;
    env: { NODE_ENV: string; CI: boolean };
  };
  // 渲染层各 manager 单例（window.X = ... 在各自文件里赋值；类经文件尾 guarded module.exports 可被 typeof import 引用）
  tabManager: TabManager;
  titlebarManager: TitlebarManager;
  sidebarManager: SidebarManager;
  sampleTester: SampleTester;
  dialogManager: DialogManager;
  browserManager: BrowserManager;
  codeComparer: InstanceType<typeof import('../js/sidebar/codeComparer.js')>;
  cloudSyncPanel: CloudSyncPanel;
  editorManager: MonacoEditorManager;
  monacoEditorManager: MonacoEditorManager;
  compilerManager: CompilerManager;
  oicppApp: OICPPApp;
  OICPPApp: typeof OICPPApp;
  MonacoEditorManager: typeof MonacoEditorManager;
  CompilerManager: typeof CompilerManager;
  IntegratedTerminalPanel: typeof IntegratedTerminalPanel;
  OicppLspUtils: typeof import('../js/lsp-utils.js');
  // 从未赋值，仅死守卫读（window.sidebar / window.fileExplorer / window.app.* 无赋值位点）
  sidebar?: SidebarManager;
  fileExplorer?: unknown;
  app?: {
    editorManager?: MonacoEditorManager;
    fileExplorer?: unknown;
    isDebugging?: boolean;
    startDebug?: () => void;
  };
  uiIcons: { svg: (name: string) => string; hydrate: (root?: Document | Element) => void };
  folderPicker: { show: (opts?: { startPath?: string }) => Promise<string | null> };
  quickOpen: { open: () => void; close: () => void; ensureIndex: () => Promise<boolean> };
  clangFormatOptions: {
    OPTION_DEFS: Record<string, { type: string; values?: string[]; default: unknown }>;
    PRESET_STYLES: Set<string>;
    getDefaultClangFormatStyle: () => Record<string, unknown>;
    normalizeClangFormatStyle: (raw: unknown) => Record<string, unknown>;
    serializeClangFormatStyle: (style: unknown) => string;
    parseClangFormatText: (text: string) => Record<string, unknown>;
    generateClangFormatText: (style: unknown) => string;
  };
  applySettings: (settings: Record<string, unknown>) => void;
  updateSettings: (newSettings: Record<string, unknown>) => Promise<boolean>;
  getCurrentSettings: () => Promise<Record<string, unknown>>;
  checkSidebarResize: () => unknown;
  initializeApp: () => Promise<void>;
  debugUIInitialized: boolean;
  debugIPCInitialized: boolean;
  __oicppDiscardClose: boolean;
  FitAddon: { FitAddon: typeof import('@xterm/addon-fit').FitAddon };
  Unicode11Addon: { Unicode11Addon: typeof import('@xterm/addon-unicode11').Unicode11Addon };
  webkitRequestAnimationFrame?: (callback: FrameRequestCallback) => number;
  mozRequestAnimationFrame?: (callback: FrameRequestCallback) => number;
  queryLocalFonts?: (options?: unknown) => Promise<Array<{ family: string; fullName: string; postscriptName: string; style: string }>>;
  TemplatesSettings: typeof import('../settings/templates.js').TemplatesSettings;
  debugUI?: unknown;
  TitlebarManager: typeof TitlebarManager;
  SidebarManager: typeof SidebarManager;
  CloudSyncPanel: typeof CloudSyncPanel;
  CodeComparer: typeof import('../js/sidebar/codeComparer.js');
  DebugPanel: typeof DebugPanel;
  FileExplorer: typeof import('../js/sidebar/fileExplorer.js');
  Terminal: typeof import('@xterm/xterm').Terminal;
}

