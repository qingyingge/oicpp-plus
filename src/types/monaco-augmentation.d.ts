// monaco-editor 模块增强：代码挂载的自定义属性（monaco 公共 API 之外）。
// 必须是模块文件（export {};）+ 指向声明模块（editor.api）+ 嵌套 namespace 作用域——
// IStandaloneCodeEditor/ITextModel 在 editor 命名空间内，ILink/CodeLens/InlayHint 在 languages 命名空间内；
// 顶层 interface 不合并（tsgo 实测），script d.ts 里的 declare module 会被整体替换（非合并）。
export {};

declare module 'monaco-editor/editor/editor.api' {
  namespace editor {
    interface ITextModel {
      __oicppFilePath?: string | null;
      __oicppLspUri?: string;
      __oicppLspCompletionFallbackUntil?: number;
    }
    interface IStandaloneCodeEditor {
      filePath?: string | null;
      fileName?: string;
      getFilePath?: () => string | null;
      onDidType?: (listener: (text: string) => void) => IDisposable;
      __markdownPreviewContextKey?: { set: (value: boolean) => void };
    }
    interface IStandaloneDiffEditor {
      __isDiffEditor?: boolean;
      __diffMeta?: { originalPath?: string; modifiedPath?: string; label?: string };
      filePath?: string | null;
      fileName?: string;
      getValue?: () => string;
      setValue?: (val: string) => void;
    }
  }
  namespace languages {
    interface ILink {
      __oicppLspDocumentLink?: unknown;
    }
    interface CodeLens {
      __oicppLspCodeLens?: unknown;
    }
    class InlayHint {
      __oicppLspInlayHint?: unknown;
    }
    // AMD 运行时可能不存在的 API：代码用 typeof 守卫防御（registerWorkspaceSymbolProvider 在 0.57 chunks 中不存在）
    const registerWorkspaceSymbolProvider: ((provider: unknown) => IDisposable) | undefined;
  }
}
