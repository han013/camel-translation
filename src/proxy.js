const vscode = require("vscode");
const { HttpError, assertHttpUrl, normalizeProxyUrl, request, sanitizeError } = require("./net");
const { chooseFastest, parseSubscription, publicNode } = require("./subscription");

const STATE_KEY = "camelTranslation.proxyCache";
const STALE_MS = 6 * 60 * 60 * 1000;
const PROBE_LIMIT = 30;
const PROBE_URL = "https://www.gstatic.com/generate_204";
const SUBSCRIPTION_UA = "clash-meta/1.19.0";

const listeners = new Set();
let extensionContext;
let busy = false;
let lastMessage = "";
let lastError = "";
let working;

function onDidChange(listener) {
    listeners.add(listener);
    return {
        dispose() {
            listeners.delete(listener);
        },
    };
}

function emit() {
    for (const listener of listeners) {
        listener();
    }
}

function configuration() {
    return vscode.workspace.getConfiguration("camelTranslation");
}

function updateTarget(key) {
    const inspected = configuration().inspect(key);
    if (inspected && inspected.workspaceFolderValue !== undefined) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspected && inspected.workspaceValue !== undefined) {
        return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
}

async function updateSetting(key, value) {
    await configuration().update(key, value, updateTarget(key));
    emit();
}

function readTimeout() {
    const value = Number(configuration().get("proxy.timeout", 15000));
    if (!Number.isFinite(value)) {
        return 15000;
    }
    return Math.min(60000, Math.max(3000, Math.round(value)));
}

function readState() {
    return extensionContext.globalState.get(STATE_KEY);
}

async function writeState(state) {
    await extensionContext.globalState.update(STATE_KEY, state);
    emit();
}

function selectedNode(state = readState()) {
    if (!state || !state.selectedId) {
        return null;
    }
    return (state.nodes || []).find((node) => node.id === state.selectedId) || null;
}

function requireManualUrl() {
    return normalizeProxyUrl(configuration().get("proxy.url", ""));
}

function optionalManualUrl() {
    const value = String(configuration().get("proxy.url", "") || "").trim();
    if (!value) {
        return "";
    }
    try {
        return normalizeProxyUrl(value);
    } catch (error) {
        return "";
    }
}

function requireSubscriptionUrl() {
    const value = String(configuration().get("proxy.subscriptionUrl", "") || "").trim();
    if (!value) {
        throw new HttpError("请先填写机场订阅地址");
    }
    return assertHttpUrl(value, "订阅地址");
}

async function mapPool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

async function fetchText(url, proxy) {
    const response = await request(url, {
        method: "GET",
        userAgent: SUBSCRIPTION_UA,
        headers: { accept: "*/*" },
        timeout: 20000,
        maxBytes: 2000000,
        proxy: proxy || undefined,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new HttpError(`订阅地址返回了 HTTP ${response.status}`, {
            network: response.status >= 500 || response.status === 407,
            status: response.status,
        });
    }
    return response.body.toString("utf8");
}

async function fetchSubscription(url) {
    try {
        return await fetchText(url);
    } catch (error) {
        const manual = optionalManualUrl();
        if (!manual) {
            throw new HttpError(`订阅拉取失败：${sanitizeError(error)}`, { network: true });
        }
        try {
            return await fetchText(url, manual);
        } catch (retryError) {
            throw new HttpError(`订阅拉取失败：${sanitizeError(retryError)}`, { network: true });
        }
    }
}

async function probeNode(node) {
    if (!node.usable || !node.proxyUrl) {
        return node;
    }
    const started = Date.now();
    try {
        const response = await request(PROBE_URL, {
            method: "GET",
            proxy: node.proxyUrl,
            timeout: 5000,
            maxBytes: 4096,
        });
        if (response.status !== 204 && response.status !== 200) {
            return { ...node, latency: null, error: `HTTP ${response.status}` };
        }
        return { ...node, latency: Date.now() - started, error: "" };
    } catch (error) {
        return { ...node, latency: null, error: sanitizeError(error) };
    }
}

async function probeNodes(nodes) {
    const usable = [];
    nodes.forEach((node, index) => {
        if (node.usable) {
            usable.push({ node, index });
        }
    });
    const targets = usable.slice(0, PROBE_LIMIT);
    const tested = await mapPool(targets, 4, (item) => probeNode(item.node));
    const next = nodes.slice();
    tested.forEach((node, offset) => {
        next[targets[offset].index] = node;
    });
    return next;
}

function describeResult(nodes, selectedId) {
    const usable = nodes.filter((node) => node.usable).length;
    const selected = nodes.find((node) => node.id === selectedId);
    const head = `已同步 ${nodes.length} 个节点，其中 ${usable} 个可直接使用`;
    if (!selected) {
        return `${head}。`;
    }
    const latency = Number.isFinite(selected.latency) ? `，${selected.latency} ms` : "";
    return `${head}。当前使用「${selected.name}」${latency}。`;
}

function emptyResultMessage(nodes) {
    const usable = nodes.filter((node) => node.usable).length;
    if (!usable) {
        return "这些节点都不是 HTTP 或 SOCKS，扩展不能直接用它们发请求。请改用手动代理，填写本机客户端端口。";
    }
    if (usable > PROBE_LIMIT) {
        return `已测试前 ${PROBE_LIMIT} 个 HTTP/SOCKS 节点，但没有一个能连上。`;
    }
    return "没有节点能连上翻译服务。可以稍后重试，或改用手动代理。";
}

async function syncSubscription(options = {}) {
    const url = options.subscriptionUrl ? assertHttpUrl(options.subscriptionUrl, "订阅地址") : requireSubscriptionUrl();
    if (options.subscriptionUrl) {
        await updateSetting("proxy.subscriptionUrl", url);
    }
    if (options.mode) {
        await updateSetting("proxy.mode", options.mode);
    }
    const body = await fetchSubscription(url);
    const parsed = parseSubscription(body);
    if (!parsed.length) {
        throw new HttpError("订阅里没有识别到节点。请确认链接有效，且返回的是 Clash、Sing-box 或分享链接。");
    }
    const previous = readState();
    const previousById = new Map(((previous && previous.nodes) || []).map((node) => [node.id, node]));
    let nodes = parsed.map((node) => {
        const old = previousById.get(node.id);
        if (!old) {
            return node;
        }
        return {
            ...node,
            latency: Number.isFinite(old.latency) ? old.latency : null,
            error: old.error || "",
        };
    });
    const sameSource = previous && previous.subscriptionUrl === url;
    let selectedId = sameSource ? previous.selectedId : null;
    if (selectedId && !nodes.some((node) => node.id === selectedId && node.usable)) {
        selectedId = null;
    }
    const selection = configuration().get("proxy.selection", "auto");
    const shouldSelect = options.select || (selection === "auto" && !selectedId);
    if (shouldSelect) {
        nodes = await probeNodes(nodes);
        const best = chooseFastest(nodes);
        selectedId = best ? best.id : null;
        lastError = best ? "" : emptyResultMessage(nodes);
        if (selection !== "auto") {
            await updateSetting("proxy.selection", "auto");
        }
    } else {
        lastError = "";
    }
    if (nodes.filter((node) => node.usable).length > PROBE_LIMIT && shouldSelect) {
        lastMessage = `${describeResult(nodes, selectedId)} 可用节点较多，本次只测试了前 ${PROBE_LIMIT} 个。`;
    } else {
        lastMessage = describeResult(nodes, selectedId);
    }
    await writeState({
        subscriptionUrl: url,
        syncedAt: Date.now(),
        nodes,
        selectedId: selectedId || "",
    });
    return readState();
}

async function autoSelect() {
    const state = readState();
    if (!state || !state.nodes || !state.nodes.length) {
        return syncSubscription({ select: true });
    }
    const nodes = await probeNodes(state.nodes);
    const best = chooseFastest(nodes);
    lastError = best ? "" : emptyResultMessage(nodes);
    lastMessage = best ? `已选择「${best.name}」，延迟 ${best.latency} ms。` : lastError;
    if (configuration().get("proxy.selection", "auto") !== "auto") {
        await updateSetting("proxy.selection", "auto");
    }
    await writeState({ ...state, nodes, selectedId: best ? best.id : "" });
    return readState();
}

async function selectNode(id) {
    const state = readState();
    const node = state && (state.nodes || []).find((item) => item.id === id);
    if (!node) {
        throw new HttpError("节点不存在，请重新同步");
    }
    if (!node.usable || !node.proxyUrl) {
        throw new HttpError(`「${node.name}」是 ${node.type}，不能直接用来发请求`);
    }
    await updateSetting("proxy.selection", "manual");
    lastError = "";
    lastMessage = `已切换到「${node.name}」。`;
    await writeState({ ...state, selectedId: node.id });
}

async function resolveProxyUrl() {
    const mode = configuration().get("proxy.mode", "off");
    if (!mode || mode === "off") {
        return "";
    }
    if (mode === "manual") {
        return requireManualUrl();
    }
    const url = requireSubscriptionUrl();
    let state = readState();
    const missing = !state || state.subscriptionUrl !== url || !state.nodes || !state.nodes.length;
    if (missing) {
        state = await syncSubscription({ select: configuration().get("proxy.selection", "auto") === "auto" });
    } else if (Date.now() - state.syncedAt > STALE_MS) {
        syncSubscription({ select: configuration().get("proxy.selection", "auto") === "auto" }).catch((error) => {
            console.error(error);
        });
    }
    if (configuration().get("proxy.selection", "auto") === "auto" && !state.selectedId) {
        state = await autoSelect();
    }
    const node = selectedNode(state);
    if (!node) {
        throw new HttpError(lastError || "请先同步并选择一个 HTTP 或 SOCKS 节点");
    }
    if (!node.usable || !node.proxyUrl) {
        throw new HttpError(`节点「${node.name}」是 ${node.type}，不能直接用来发请求。请改选 HTTP/SOCKS 节点，或填写手动代理。`);
    }
    return node.proxyUrl;
}

function peekNext(currentUrl) {
    const mode = configuration().get("proxy.mode", "off");
    if (mode !== "subscription" || configuration().get("proxy.selection", "auto") !== "auto") {
        return "";
    }
    const state = readState();
    if (!state) {
        return "";
    }
    const candidates = (state.nodes || []).filter((node) => node.usable && node.proxyUrl && node.proxyUrl !== currentUrl && Number.isFinite(node.latency)).sort((left, right) => left.latency - right.latency);
    return candidates[0] ? candidates[0].proxyUrl : "";
}

async function commitSelection(proxyUrl) {
    const state = readState();
    if (!state) {
        return;
    }
    const node = (state.nodes || []).find((item) => item.proxyUrl === proxyUrl);
    if (!node) {
        return;
    }
    lastMessage = `已改用「${node.name}」。`;
    await writeState({ ...state, selectedId: node.id });
}

function getStatus() {
    const mode = configuration().get("proxy.mode", "off");
    if (mode === "manual") {
        return {
            text: "$(globe) 驼峰翻译 · 手动代理",
            tooltip: "点击打开设置",
            command: "extension.camelTranslation.openSettings",
        };
    }
    if (mode === "subscription") {
        const node = selectedNode();
        const name = node ? (node.name.length > 18 ? `${node.name.slice(0, 18)}…` : node.name) : "未选择";
        const latency = node && Number.isFinite(node.latency) ? ` ${node.latency}ms` : "";
        return {
            text: `$(globe) 驼峰翻译 · ${name}${latency}`,
            tooltip: "点击切换代理节点",
            command: "extension.camelTranslation.switchProxy",
        };
    }
    return {
        text: "$(globe) 驼峰翻译 · 直连",
        tooltip: "点击打开设置",
        command: "extension.camelTranslation.openSettings",
    };
}

function snapshot() {
    const config = configuration();
    const state = readState();
    return {
        busy,
        settings: {
            translationEngine: config.get("translationEngine", "google"),
            BaiDuKey: config.get("BaiDuKey", ""),
            BaiDuSecret: config.get("BaiDuSecret", ""),
            YouDaoKey: config.get("YouDaoKey", ""),
            YouDaoSecret: config.get("YouDaoSecret", ""),
            proxyMode: config.get("proxy.mode", "off"),
            proxyUrl: config.get("proxy.url", ""),
            subscriptionUrl: config.get("proxy.subscriptionUrl", ""),
            selection: config.get("proxy.selection", "auto"),
            timeout: readTimeout(),
        },
        nodes: ((state && state.nodes) || []).map(publicNode),
        selectedId: (state && state.selectedId) || "",
        syncedAt: (state && state.syncedAt) || 0,
        lastMessage,
        lastError,
    };
}

function enqueue(task) {
    if (working) {
        return working;
    }
    busy = true;
    emit();
    working = task()
        .catch((error) => {
            lastError = sanitizeError(error);
            emit();
            throw error;
        })
        .finally(() => {
            busy = false;
            working = null;
            emit();
        });
    return working;
}

function init(context) {
    extensionContext = context;
}

module.exports = {
    autoSelect,
    commitSelection,
    enqueue,
    getStatus,
    init,
    onDidChange,
    peekNext,
    readTimeout,
    requireSubscriptionUrl,
    resolveProxyUrl,
    selectNode,
    snapshot,
    syncSubscription,
    updateSetting,
};
