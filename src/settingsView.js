const vscode = require("vscode");
const { assertHttpUrl, normalizeProxyUrl } = require("./net");
const proxy = require("./proxy");

const ALLOWED_KEYS = new Set(["translationEngine", "BaiDuKey", "BaiDuSecret", "YouDaoKey", "YouDaoSecret", "proxy.mode", "proxy.url", "proxy.subscriptionUrl", "proxy.selection"]);

let currentPanel;
let subscription;

function nonce() {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let value = "";
    for (let i = 0; i < 24; i += 1) {
        value += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return value;
}

function html(webview, token, logo) {
    const csp = ["default-src 'none'", `img-src ${webview.cspSource}`, `style-src 'nonce-${token}'`, `script-src 'nonce-${token}'`].join("; ");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>驼峰翻译助手</title>
<style nonce="${token}">
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
    margin: 0;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.5;
}
main { max-width: 820px; margin: 0 auto; padding: 28px 24px 48px; }
header { display: flex; gap: 14px; align-items: center; margin-bottom: 22px; }
header img { width: 44px; height: 44px; border-radius: 10px; }
h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0; }
header p, .hint, .meta { margin: 2px 0 0; color: var(--vscode-descriptionForeground); }
section {
    margin-top: 16px;
    padding: 16px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 10px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
}
h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.engines, .modes { display: grid; gap: 8px; }
.engines { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.modes { grid-template-columns: repeat(3, minmax(0, 1fr)); }
button, input, select {
    font: inherit;
    color: inherit;
}
.choice, .node, .action, .primary {
    border-radius: 8px;
    border: 1px solid var(--vscode-widget-border, transparent);
    background: transparent;
    text-align: left;
}
.choice, .node { padding: 10px 12px; cursor: pointer; width: 100%; }
.choice strong, .node strong { display: block; font-weight: 600; }
.choice span, .node span, .badge { color: var(--vscode-descriptionForeground); }
.choice[aria-pressed="true"], .node[aria-pressed="true"] {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground, inherit);
}
.choice:hover, .node:hover, .action:hover { background: var(--vscode-list-hoverBackground); }
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
label { display: block; }
label em { display: block; margin-bottom: 6px; font-style: normal; }
input, select {
    width: 100%;
    padding: 7px 9px;
    border-radius: 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
}
input:focus, select:focus, button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
}
.panel { margin-top: 14px; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.primary, .action { padding: 6px 12px; cursor: pointer; }
.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
}
.primary:hover { background: var(--vscode-button-hoverBackground); }
.action { background: var(--vscode-input-background); }
button:disabled { opacity: 0.55; cursor: default; }
.nodes { display: flex; flex-direction: column; gap: 6px; max-height: 360px; overflow: auto; margin-top: 12px; }
.node { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.node small { display: block; color: var(--vscode-descriptionForeground); }
.badge {
    flex: none;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
}
.node[disabled] { opacity: 0.72; cursor: default; }
.banner {
    margin-top: 12px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--vscode-inputValidation-infoBackground, var(--vscode-textBlockQuote-background));
}
.banner.error { background: var(--vscode-inputValidation-errorBackground); }
.empty { padding: 18px 8px; text-align: center; }
@media (max-width: 640px) {
    .fields, .modes { grid-template-columns: 1fr; }
    main { padding: 18px 14px 32px; }
}
</style>
</head>
<body>
<main>
    <header>
        <img id="logo" alt="" width="44" height="44" src="${logo}" />
        <div>
            <h1>驼峰翻译助手</h1>
            <p>把选中的文字译成英文，再换成变量名。英文会直接转换，不请求网络。</p>
        </div>
    </header>
    <section>
        <h2>翻译引擎</h2>
        <div id="engines" class="engines"></div>
    </section>
    <section>
        <h2>服务密钥</h2>
        <p class="hint">只有百度和有道需要。密钥保存在本机的 VS Code 设置里。</p>
        <div class="fields">
            <label><em>百度应用 ID</em><input id="BaiDuKey" data-key="BaiDuKey" autocomplete="off" /></label>
            <label><em>百度密钥</em><input id="BaiDuSecret" data-key="BaiDuSecret" type="password" autocomplete="off" /></label>
            <label><em>有道应用 ID</em><input id="YouDaoKey" data-key="YouDaoKey" autocomplete="off" /></label>
            <label><em>有道密钥</em><input id="YouDaoSecret" data-key="YouDaoSecret" type="password" autocomplete="off" /></label>
        </div>
    </section>
    <section>
        <h2>代理</h2>
        <p class="hint">请求可以走手动代理，也可以从机场订阅里同步 HTTP / SOCKS 节点。vmess、trojan、ss 等协议会列出来，但不能直接用来发请求。</p>
        <div id="modes" class="modes"></div>
        <div id="manual" class="panel" hidden>
            <label><em>代理地址</em><input id="proxyUrl" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891" autocomplete="off" /></label>
            <p class="hint">已经开了 Clash、V2Ray 或其他客户端时，填它的本地端口即可。</p>
        </div>
        <div id="subscription" class="panel" hidden>
            <label><em>订阅地址</em><input id="subscriptionUrl" placeholder="https://example.com/api/v1/client/subscribe?token=..." autocomplete="off" /></label>
            <div class="row">
                <button id="sync" class="primary" type="button">同步节点</button>
                <button id="auto" class="action" type="button">测速并自动选择</button>
                <span id="meta" class="meta"></span>
            </div>
            <div id="banner"></div>
            <div id="nodes" class="nodes"></div>
        </div>
    </section>
</main>
<script nonce="${token}">
const vscode = acquireVsCodeApi();
const engines = [
    ['google', '谷歌', 'googleapis'],
    ['googleCN', '谷歌中国', 'google.cn'],
    ['bing', '必应', '无需密钥'],
    ['baidu', '百度', '需要应用密钥'],
    ['youdao', '有道', '需要应用密钥']
];
const modes = [
    ['off', '不使用', '直接连接'],
    ['manual', '手动地址', '本地或远程代理'],
    ['subscription', '机场订阅', '同步后自动或手动选']
];
let state = { settings: {}, nodes: [], busy: false };
const $ = (id) => document.getElementById(id);

function send(message) { vscode.postMessage(message); }
function pressed(list, value) {
    list.querySelectorAll('button').forEach((button) => {
        button.setAttribute('aria-pressed', button.dataset.value === value ? 'true' : 'false');
    });
}
function fill(id, value) {
    const input = $(id);
    if (document.activeElement === input) return;
    input.value = value || '';
}
function renderChoices(container, items, current, onPick) {
    container.textContent = '';
    items.forEach(([value, title, detail]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice';
        button.dataset.value = value;
        button.setAttribute('aria-pressed', value === current ? 'true' : 'false');
        const name = document.createElement('strong');
        name.textContent = title;
        const desc = document.createElement('span');
        desc.textContent = detail;
        button.append(name, desc);
        button.addEventListener('click', () => onPick(value));
        container.append(button);
    });
}
function latencyText(node) {
    if (!node.usable) return node.type + ' · 不能直接使用';
    if (typeof node.latency === 'number') return node.latency + ' ms';
    if (node.error) return node.error;
    return '未测速';
}
function renderNodes() {
    const box = $('nodes');
    box.textContent = '';
    const nodes = (state.nodes || []).slice().sort((a, b) => Number(b.usable) - Number(a.usable) || (a.latency || 999999) - (b.latency || 999999));
    if (!nodes.length) {
        const empty = document.createElement('div');
        empty.className = 'empty hint';
        empty.textContent = '还没有节点。填写订阅地址后点「同步节点」。';
        box.append(empty);
        return;
    }
    nodes.forEach((node) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'node';
        button.disabled = !node.usable || state.busy;
        button.setAttribute('aria-pressed', node.id === state.selectedId ? 'true' : 'false');
        const text = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = node.name;
        const detail = document.createElement('small');
        detail.textContent = (node.server ? node.server + ':' + node.port + ' · ' : '') + latencyText(node);
        text.append(title, detail);
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = node.type;
        button.append(text, badge);
        button.addEventListener('click', () => send({ type: 'select', id: node.id }));
        box.append(button);
    });
}
function renderBanner() {
    const banner = $('banner');
    banner.textContent = '';
    const message = state.lastError || state.lastMessage;
    if (!message) return;
    const box = document.createElement('div');
    box.className = state.lastError ? 'banner error' : 'banner';
    box.textContent = message;
    banner.append(box);
}
function render() {
    const settings = state.settings || {};
    renderChoices($('engines'), engines, settings.translationEngine, (value) => send({ type: 'update', key: 'translationEngine', value: value }));
    renderChoices($('modes'), modes, settings.proxyMode, (value) => send({ type: 'update', key: 'proxy.mode', value: value }));
    pressed($('engines'), settings.translationEngine);
    pressed($('modes'), settings.proxyMode);
    ['BaiDuKey', 'BaiDuSecret', 'YouDaoKey', 'YouDaoSecret'].forEach((id) => fill(id, settings[id]));
    fill('proxyUrl', settings.proxyUrl);
    fill('subscriptionUrl', settings.subscriptionUrl);
    $('manual').hidden = settings.proxyMode !== 'manual';
    $('subscription').hidden = settings.proxyMode !== 'subscription';
    const when = state.syncedAt ? '上次同步 ' + new Date(state.syncedAt).toLocaleString() : '';
    $('meta').textContent = state.busy ? '正在处理…' : when;
    $('sync').disabled = state.busy;
    $('auto').disabled = state.busy;
    renderBanner();
    renderNodes();
}
document.querySelectorAll('input[data-key]').forEach((input) => {
    input.addEventListener('change', () => send({ type: 'update', key: input.dataset.key, value: input.value }));
});
$('proxyUrl').addEventListener('change', () => send({ type: 'update', key: 'proxy.url', value: $('proxyUrl').value.trim() }));
$('subscriptionUrl').addEventListener('change', () => send({ type: 'update', key: 'proxy.subscriptionUrl', value: $('subscriptionUrl').value.trim() }));
$('sync').addEventListener('click', () => send({ type: 'sync', subscriptionUrl: $('subscriptionUrl').value.trim() }));
$('auto').addEventListener('click', () => send({ type: 'auto', subscriptionUrl: $('subscriptionUrl').value.trim() }));
$('logo').addEventListener('error', () => $('logo').remove());
window.addEventListener('message', (event) => {
    state = event.data || state;
    render();
});
render();
send({ type: 'ready' });
</script>
</body>
</html>`;
}

function postState() {
    if (currentPanel) {
        currentPanel.webview.postMessage(proxy.snapshot());
    }
}

async function saveSetting(key, value) {
    if (!ALLOWED_KEYS.has(key)) {
        return;
    }
    let next = value;
    if (key === "proxy.url" && next) {
        next = normalizeProxyUrl(next);
    }
    if (key === "proxy.subscriptionUrl" && next) {
        next = assertHttpUrl(next, "订阅地址");
    }
    if (key === "translationEngine" && !["google", "googleCN", "bing", "baidu", "youdao"].includes(next)) {
        return;
    }
    if (key === "proxy.mode" && !["off", "manual", "subscription"].includes(next)) {
        return;
    }
    if (key === "proxy.selection" && !["auto", "manual"].includes(next)) {
        return;
    }
    await proxy.updateSetting(key, next);
}

async function onMessage(message) {
    if (!message || typeof message !== "object") {
        return;
    }
    try {
        if (message.type === "ready") {
            postState();
            return;
        }
        if (message.type === "update") {
            await saveSetting(message.key, message.value);
            return;
        }
        if (message.type === "sync" || message.type === "auto") {
            await proxy.enqueue(() =>
                proxy.syncSubscription({
                    subscriptionUrl: message.subscriptionUrl,
                    mode: "subscription",
                    select: message.type === "auto" || proxy.snapshot().settings.selection === "auto",
                }),
            );
            return;
        }
        if (message.type === "select") {
            await proxy.selectNode(message.id);
        }
    } catch (error) {
        vscode.window.showErrorMessage(error.message || "设置保存失败");
        postState();
    }
}

function openSettings(context) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Active);
        postState();
        return;
    }
    const token = nonce();
    currentPanel = vscode.window.createWebviewPanel("camelTranslation.settings", "驼峰翻译助手", vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
    });
    const logo = currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "images", "logo.png"));
    currentPanel.webview.html = html(currentPanel.webview, token, logo);
    currentPanel.webview.onDidReceiveMessage(onMessage);
    currentPanel.onDidDispose(() => {
        currentPanel = null;
    });
    if (!subscription) {
        subscription = proxy.onDidChange(postState);
        context.subscriptions.push(subscription);
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("camelTranslation")) {
                    postState();
                }
            }),
        );
    }
}

module.exports = { openSettings };
