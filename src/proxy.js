const vscode = require("vscode");
const { normalizeProxyUrl } = require("./net");

const listeners = new Set();

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

function resolveProxyUrl() {
    if (configuration().get("proxy.mode", "off") !== "manual") {
        return "";
    }
    return normalizeProxyUrl(configuration().get("proxy.url", ""));
}

function getStatus() {
    if (configuration().get("proxy.mode", "off") === "manual") {
        return {
            text: "$(globe) 驼峰翻译 · 手动代理",
            tooltip: "点击打开设置",
            command: "extension.camelTranslation.openSettings",
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
    return {
        settings: {
            translationEngine: config.get("translationEngine", "google"),
            BaiDuKey: config.get("BaiDuKey", ""),
            BaiDuSecret: config.get("BaiDuSecret", ""),
            YouDaoKey: config.get("YouDaoKey", ""),
            YouDaoSecret: config.get("YouDaoSecret", ""),
            proxyMode: config.get("proxy.mode", "off") === "manual" ? "manual" : "off",
            proxyUrl: config.get("proxy.url", ""),
            timeout: readTimeout(),
        },
    };
}

function init() {}

module.exports = {
    getStatus,
    init,
    onDidChange,
    readTimeout,
    resolveProxyUrl,
    snapshot,
    updateSetting,
};
