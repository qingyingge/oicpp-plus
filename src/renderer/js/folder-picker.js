"use strict";
const E = (t, c, txt) => {
    const e = document.createElement(t);
    if (c)
        e.className = c;
    if (txt !== undefined)
        e.textContent = txt;
    return e;
};
const _t = (key) => window.i18n?.t?.(key) || key;
const norm = (...ps) => ps.join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
function buildBreadcrumb(path, bar, onChange) {
    bar.innerHTML = '';
    const upBtn = E('button', 'folder-picker-up', '⬆');
    upBtn.title = _t('folderPicker.parentDir');
    upBtn.onclick = () => {
        if (path === '/' || /^[A-Za-z]:\/$/.test(path))
            return;
        const parent = path.replace(/[\\/]+$/, '').replace(/[/\\][^/\\]+$/, '') || '/';
        onChange(parent);
    };
    bar.appendChild(upBtn);
    const parts = path.split(/\/+?/).filter(Boolean);
    let acc = path.startsWith('/') ? '/' : '';
    if (path.startsWith('/')) {
        const root = E('div', 'folder-picker-breadcrumb', '/');
        root.onclick = () => { if (path !== '/')
            onChange('/'); };
        bar.appendChild(root);
    }
    else if (/^[A-Za-z]:\\?$/.test(path)) {
        const drv = path.slice(0, 2);
        const root = E('div', 'folder-picker-breadcrumb', drv);
        root.onclick = () => onChange(drv + '/');
        bar.appendChild(root);
    }
    for (const seg of parts) {
        if (seg === '')
            continue;
        acc = acc === '/' ? ('/' + seg) : (acc ? acc + '/' + seg : seg);
        const c = E('div', 'folder-picker-breadcrumb', seg);
        const targetPath = acc;
        c.onclick = () => onChange(targetPath);
        bar.appendChild(c);
    }
}
function getQuickAccess(homeDir) {
    const list = [];
    if (homeDir)
        list.push({ name: _t('folderPicker.homeDir'), path: norm(homeDir) });
    if (process.platform !== 'win32')
        list.push({ name: _t('folderPicker.rootDir'), path: '/' });
    return list;
}
if (typeof window !== 'undefined' && !window.folderPicker) {
    const module = {
        async show(opts = {}) {
            const homeDir = await (window.electronAPI?.getUserHome?.() || '');
            return new Promise((resolve) => {
                const theme = (window.oicppApp?.settings?.theme) || 'dark';
                const isLightTheme = String(theme).toLowerCase().includes('light');
                // norm 统一反斜杠为正斜杠、折叠重复分隔符：来自 startPath/lastOpen 的
                // Windows 路径必须加 norm，否则 buildBreadcrumb 把 `C:\Users\foo` 切成
                // 单个片段，面包屑只剩一级。同时 USERPROFILE 不再走 process.env（只暴露
                // NODE_ENV/CI），改走已有的 getUserHome IPC。
                let cur = norm(opts.startPath || window.oicppApp?.settings?.lastOpen || (process.platform === 'win32' ? (homeDir || 'C:') : '/'));
                if (!cur)
                    cur = '/';
                const backdrop = E('div', 'folder-picker-backdrop');
                const panel = E('div', 'folder-picker ' + (isLightTheme ? 'light' : ''));
                backdrop.appendChild(panel);
                const header = E('div', 'folder-picker-header');
                header.appendChild(E('span', null, _t('folderPicker.selectWorkspace')));
                const close = E('span', 'folder-picker-close', '✕');
                close.onclick = () => { clean(); resolve(null); };
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
                quick.appendChild(E('div', 'folder-picker-quick-title', _t('folderPicker.quickAccess')));
                const quickList = E('div', 'folder-picker-quick-list');
                getQuickAccess(homeDir).forEach(q => {
                    const it = E('div', 'folder-picker-quick-item', q.name);
                    it.title = q.path;
                    it.onclick = () => { cur = q.path; reload(); };
                    quickList.appendChild(it);
                });
                quick.appendChild(quickList);
                side.appendChild(quick);
                const search = E('input', 'folder-picker-search');
                search.placeholder = _t('folderPicker.filterDir');
                side.appendChild(search);
                const createWrap = E('div', 'folder-picker-create');
                const createInput = E('input');
                createInput.placeholder = _t('folderPicker.createFolder');
                const createBtn = E('button', null, _t('folderPicker.create'));
                createBtn.onclick = async () => {
                    const name = createInput.value.trim();
                    if (!name)
                        return;
                    await window.electronAPI?.ensureDirectory?.(norm(cur, name));
                    createInput.value = '';
                    reload();
                };
                createWrap.appendChild(createInput);
                createWrap.appendChild(createBtn);
                side.appendChild(createWrap);
                const footer = E('div', 'folder-picker-footer');
                const tip = E('div', null, _t('folderPicker.selectHint'));
                tip.style.fontSize = '12px';
                tip.style.opacity = '.7';
                tip.style.flex = '1';
                const actions = E('div', 'folder-picker-actions');
                const cancel = E('button', 'folder-picker-btn secondary', _t('folderPicker.cancel'));
                const choose = E('button', 'folder-picker-btn', _t('folderPicker.selectThis'));
                cancel.onclick = () => { clean(); resolve(null); };
                choose.onclick = () => { clean(); resolve(cur); };
                actions.appendChild(cancel);
                actions.appendChild(choose);
                footer.appendChild(tip);
                footer.appendChild(actions);
                panel.appendChild(footer);
                document.body.appendChild(backdrop);
                let destroyed = false;
                function clean() { if (destroyed)
                    return; destroyed = true; backdrop.remove(); }
                async function reload() {
                    choose.disabled = true;
                    buildBreadcrumb(cur, bar, p => { cur = p; reload(); });
                    treeWrap.innerHTML = '<div class="folder-picker-loading">' + _t('folderPicker.loading') + '</div>';
                    let entries = [], error = null;
                    try {
                        // readDirectory 的声明把坏条目写成可空；主进程侧已在源头过滤，这里按实际形状收窄（擦除式断言，不改运行期）
                        entries = (await window.electronAPI?.readDirectory?.(cur));
                    }
                    catch (e) {
                        error = e;
                    }
                    const folders = (entries || []).filter(i => i.type === 'folder');
                    const f = search.value.trim().toLowerCase();
                    treeWrap.innerHTML = '';
                    if (error) {
                        const err = E('div', 'folder-picker-error');
                        err.innerHTML = '<div>' + _t('folderPicker.noAccess') + '</div>';
                        const backBtn = E('button', 'folder-picker-btn secondary', _t('folderPicker.goBack'));
                        backBtn.onclick = () => {
                            const parent = cur.replace(/[\\/]+$/, '').replace(/[/\\][^/\\]+$/, '') || '/';
                            cur = parent;
                            reload();
                        };
                        err.appendChild(backBtn);
                        treeWrap.appendChild(err);
                        choose.disabled = true;
                        return;
                    }
                    const list = folders.filter(d => !f || (d.name ?? '').toLowerCase().includes(f));
                    if (list.length === 0) {
                        treeWrap.appendChild(E('div', 'folder-picker-empty', _t('folderPicker.emptyDir')));
                    }
                    list.forEach(d => {
                        const item = E('div', 'folder-picker-item folder');
                        item.innerHTML = '<span class="folder-picker-icon" data-ui-icon="folder" aria-hidden="true"></span><span></span>';
                        if (item.lastChild)
                            item.lastChild.textContent = d.name ?? '';
                        item.onclick = () => {
                            selectItem(item, d);
                        };
                        item.ondblclick = () => { cur = d.path ?? ''; reload(); };
                        treeWrap.appendChild(item);
                    });
                    if (window.uiIcons && typeof window.uiIcons.hydrate === 'function') {
                        window.uiIcons.hydrate(treeWrap);
                    }
                    choose.disabled = false;
                }
                function clearActive() {
                    treeWrap.querySelectorAll('.folder-picker-item.active').forEach(i => i.classList.remove('active'));
                }
                function selectItem(el, d) {
                    clearActive();
                    el.classList.add('active');
                    cur = d.path ?? '';
                }
                search.oninput = () => reload();
                reload();
            });
        }
    };
    window.folderPicker = module;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.folderPicker;
}
