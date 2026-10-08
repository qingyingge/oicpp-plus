// 全局声明：主进程/渲染层/preload 通过 contextBridge 或 AMD loader 注入的全局。
// 路线甲阶段只做「名称可解析」，签名先用 any，A3 负责把 electronAPI 细化。

declare function logInfo(...args: unknown[]): void;
declare function logWarn(...args: unknown[]): void;
declare function logError(...args: unknown[]): void;
declare function logwarn(...args: unknown[]): void;
declare function logerror(...args: unknown[]): void;

// Monaco AMD loader 注入（AMD 运行时 API 面比 ESM 公共类型大，精确类型化待 2c-mono 批）
declare const monaco: any;
// 渲染层 4 个 manager 单例：类在各文件顶层声明，经文件尾 guarded module.exports 可被 typeof import 精确引用
declare const OICPPApp: typeof import('../js/main.js');
declare const MonacoEditorManager: typeof import('../js/monaco-editor-manager.js');
declare const CompilerManager: typeof import('../js/compile-manager.js');
declare const DebugPanel: typeof import('../js/sidebar/debugPanel.js');
// 主进程 require 由 @types/node 全局声明接管（electron 的 /// <reference types="node" /> 引入）
declare function require(moduleName: string): any;
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
  hasGlobalWheelZoomListener?: boolean;
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
  monaco: any;
  require: ((moduleName: string) => any) & { __electronHelper?: boolean };
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
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
    once: (channel: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
    removeAllListeners: (channel: string) => void;
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (...args: unknown[]) => void) => void;
      once: (channel: string, listener: (...args: unknown[]) => void) => void;
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
      removeAllListeners: (channel: string) => void;
    };
  };
  electron: {
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (...args: unknown[]) => void) => void;
      once: (channel: string, listener: (...args: unknown[]) => void) => void;
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
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
      on: (channel: string, listener: (...args: unknown[]) => void) => void;
      once: (channel: string, listener: (...args: unknown[]) => void) => void;
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
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
  fontDetector: {
    validateFont: (fontName: string) => string;
    getAllAvailableFonts: () => Promise<string[]>;
    getAllAvailableFontsSync: () => string[];
  };
  // 渲染层各 manager 单例（window.X = ... 在各自文件里赋值）
  [key: string]: any;
}
