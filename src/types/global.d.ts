// 全局声明：主进程/渲染层/preload 通过 contextBridge 或 AMD loader 注入的全局。
// 路线甲阶段只做「名称可解析」，签名先用 any，A3 负责把 electronAPI 细化。

declare function logInfo(...args: any[]): void;
declare function logWarn(...args: any[]): void;
declare function logError(...args: any[]): void;
declare function logwarn(...args: any[]): void;
declare function logerror(...args: any[]): void;

// Monaco AMD loader 注入
declare const monaco: any;
declare const DebugPanel: any;
declare const OICPPApp: any;
declare const MonacoEditorManager: any;
declare const CompilerManager: any;
declare const TabManager: any;
declare function require(moduleName: string): any;

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
}

interface Window {
  logInfo: (...args: any[]) => void;
  logWarn: (...args: any[]) => void;
  logError: (...args: any[]) => void;
  logwarn: (...args: any[]) => void;
  logerror: (...args: any[]) => void;
  monaco: any;
  require: ((moduleName: string) => any) & { __electronHelper?: boolean };
  i18n: any;
  electronIPC: any;
  electron: any;
  markdownAPI: any;
  turndownAPI: any;
  getElectronModule: () => any;
  __electronRequireAvailable: boolean;
  process: any;
  fontDetector: any;
  // 渲染层各 manager 单例（window.X = ... 在各自文件里赋值）
  [key: string]: any;
}
