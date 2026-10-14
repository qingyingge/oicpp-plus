export {};

const E = (t: string, c?: string | null, txt?: string): HTMLElement => {
    const e = document.createElement(t);
    if (c) e.className = c;
    if (txt !== undefined) e.textContent = txt;
    return e;
};

const _t = (key: string, fallback: string): string =>
    (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key) : fallback;

const norm = (...ps: string[]): string =>
    ps.join('/').replace(/\\/g, '/').replace(/\/+/g, '/');

function buildBreadcrumb(path: string, bar: HTMLElement, onChange: (p: string) => void): void {
    bar.innerHTML = '';
    const upBtn = E('button', 'folder-picker-up', '⬆');
    upBtn.title = _t('folderPicker.parentDir', 'Parent Directory');
    upBtn.onclick = () => {
        if (path === '/' || /^[A-Za-z]:\/$/.test(path)) return;
        const parent = path.replace(/[\\/]+$/, '').replace(/[/\\][^/\\]+$/, '') || '/';
        onChange(parent);
    };
    bar.appendChild(upBtn);
    const parts = path.split(/\/+?/).filter(Boolean);
    let acc = path.startsWith('/') ? '/' : '';
    if (path.startsWith('/')) {
        const root = E('div', 'folder-picker-breadcrumb', '/');
        root.onclick = () => { if (path !== '/') onChange('/'); };
        bar.appendChild(root);
    } else if (/^[A-Za-z]:\\?$/.test(path)) {
        const drv = path.slice(0, 2);
        const root = E('div', 'folder-picker-breadcrumb', drv);
        root.onclick = () => onChange(drv + '/');
        bar.appendChild(root);
    }
    for (const seg of parts) {
        if (seg === '') continue;
        acc = acc === '/' ? ('/' + seg) : (acc ? acc + '/' + seg : seg);
        const c = E('div', 'folder-picker-breadcrumb', seg);
        const targetPath = acc;
        c.onclick = () => onChange(targetPath);
        bar.appendChild(c);
    }
}

function getQuickAccess(): Array<{ name: string; path: string }> {
    const list: Array<{ name: string; path: string }> = [];
    const home = (process.platform === 'win32' ? process.env['USERPROFILE'] : process.env['HOME']) || '';
    if (home) list.push({ name: _t('folderPicker.homeDir', 'Home'), path: home.replace(/\\/g, '/') });
    if (process.platform !== 'win32') list.push({ name: _t('folderPicker.rootDir', '/ (Root)'), path: '/' });
    return list;
}

interface FolderPickerModule {
    show: (opts?: { startPath?: string }) => Promise<string | null>;
}

if (typeof window !== 'undefined' && !(window as any).folderPicker) {
    const module: FolderPickerModule = {
        show(opts = {}) {
            return new Promise<string | null>((resolve) => {
                const theme = ((window as any).oicppApp?.settings?.theme) || 'dark';
                const isLightTheme = String(theme).toLowerCase().includes('light');
                let cur = opts.startPath || (window as any).oicppApp?.settings?.lastOpen || ((process.platform === 'win32') ? (process.env['USERPROFILE'] || 'C:/') : '/');
                if (!cur) cur = '/';
                const backdrop = E('div', 'folder-picker-backdrop');
                const panel = E('div', 'folder-picker ' + (isLightTheme ? 'light' : ''));
                backdrop.appendChild(panel);
                const header = E('div', 'folder-picker-header');
                header.appendChild(E('span', null, _t('folderPicker.selectWorkspace', 'Select Workspace Folder')));
                const close = E('span', 'folder-picker-close', '✕');
                close.onclick = () => { clean(); resolve(null as string | null); };
                header.appendChild(close);
                panel.appendChild(header);
                const bar = E('div', 'folder-picker-pathbar');
                panel.appendChild(bar);
                const body = E('div', 'folder-picker-body');
                panel.appendChild(body);
                const side = E('div', 'folder-picker-side');
                body.appendChild(side);
                const treeWrap = E('div', 'folder-picker-tree');
                body.appendChild(treeWrap);

                const quick = E('div', 'folder-picker-quick');
                quick.appendChild(E('div', 'folder-picker-quick-title', _t('folderPicker.quickAccess', 'Quick Access')));
                const quickList = E('div', 'folder-picker-quick-list');
                getQuickAccess().forEach(q => {
                    const it = E('div', 'folder-picker-quick-item', q.name);
                    it.title = q.path;
                    it.onclick = () => { cur = q.path; reload(); };
                    quickList.appendChild(it);
                });
                quick.appendChild(quickList);
                side.appendChild(quick);

                const search = E('input', 'folder-picker-search') as HTMLInputElement;
                search.placeholder = _t('folderPicker.filterDir', 'Filter current directory');
                side.appendChild(search);

                const createWrap = E('div', 'folder-picker-create');
                const createInput = E('input') as HTMLInputElement;
                createInput.placeholder = _t('folderPicker.createFolder', 'New Folder');
                const createBtn = E('button', null, _t('folderPicker.create', 'Create'));
                createBtn.onclick = async () => {
                    const name = createInput.value.trim();
                    if (!name) return;
                    await (window as any).electronAPI?.ensureDirectory?.(norm(cur, name));
                    createInput.value = '';
                    reload();
                };
                createWrap.appendChild(createInput);
                createWrap.appendChild(createBtn);
                side.appendChild(createWrap);

                const footer = E('div', 'folder-picker-footer');
                const tip = E('div', null, _t('folderPicker.selectHint', 'Select and click "Choose This Directory"'));
                tip.style.fontSize = '12px';
                tip.style.opacity = '.7';
                tip.style.flex = '1';
                const actions = E('div', 'folder-picker-actions');
                const cancel = E('button', 'folder-picker-btn secondary', _t('folderPicker.cancel', 'Cancel'));
                const choose = E('button', 'folder-picker-btn', _t('folderPicker.selectThis', 'Choose This Directory')) as HTMLButtonElement;
                cancel.onclick = () => { clean(); resolve(null as string | null); };
                choose.onclick = () => { clean(); resolve(cur); };
                actions.appendChild(cancel);
                actions.appendChild(choose);
                footer.appendChild(tip);
                footer.appendChild(actions);
                panel.appendChild(footer);
                document.body.appendChild(backdrop);
                let destroyed = false;
                function clean(): void { if (destroyed) return; destroyed = true; backdrop.remove(); }

                async function reload(): Promise<void> {
                    choose.disabled = true;
                    buildBreadcrumb(cur, bar, p => { cur = p; reload(); });
                    treeWrap.innerHTML = '<div class="folder-picker-loading">' + _t('folderPicker.loading', 'Loading...') + '</div>';
                    let entries: Array<{ path?: string; name?: string; type?: string; ext?: string }> | null = [], error: Error | null = null;
                    try {
                        entries = await (window as any).electronAPI?.readDirectory?.(cur);
                    } catch (e) { error = e as Error; }
                    const folders = (entries || []).filter(i => i.type === 'folder');
                    const f = search.value.trim().toLowerCase();
                    treeWrap.innerHTML = '';
                    if (error) {
                        const err = E('div', 'folder-picker-error');
                        err.innerHTML = '<div>' + _t('folderPicker.noAccess', 'Cannot access this directory (permission denied)') + '</div>';
                        const backBtn = E('button', 'folder-picker-btn secondary', _t('folderPicker.goBack', 'Go Back'));
                        backBtn.onclick = () => {
                            const parent = cur.replace(/[\\/]+$/, '').replace(/[/\\][^/\\]+$/, '') || '/';
                            cur = parent; reload();
                        };
                        err.appendChild(backBtn);
                        treeWrap.appendChild(err);
                        choose.disabled = true;
                        return;
                    }
                    const list = folders.filter(d => !f || (d.name ?? '').toLowerCase().includes(f));
                    if (list.length === 0) {
                        treeWrap.appendChild(E('div', 'folder-picker-empty', _t('folderPicker.emptyDir', '(Empty Directory)')));
                    }
                    list.forEach(d => {
                        const item = E('div', 'folder-picker-item folder');
                        item.innerHTML = '<span class="folder-picker-icon" data-ui-icon="folder" aria-hidden="true"></span><span></span>';
                        if (item.lastChild) item.lastChild.textContent = d.name ?? '';
                        item.onclick = () => {
                            selectItem(item, d);
                        };
                        item.ondblclick = () => { cur = d.path ?? ''; reload(); };
                        treeWrap.appendChild(item);
                    });
                    if ((window as any).uiIcons && typeof (window as any).uiIcons.hydrate === 'function') {
                        (window as any).uiIcons.hydrate(treeWrap);
                    }
                    choose.disabled = false;
                }

                function clearActive(): void {
                    treeWrap.querySelectorAll('.folder-picker-item.active').forEach(i => i.classList.remove('active'));
                }
                function selectItem(el: HTMLElement, d: { path?: string; name?: string; type?: string; ext?: string }): void {
                    clearActive(); el.classList.add('active'); cur = d.path ?? '';
                }

                search.oninput = () => reload();
                reload();
            });
        }
    };
    (window as any).folderPicker = module;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = (window as any).folderPicker;
}