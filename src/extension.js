const vscode = require("vscode");
const { camelCase, pascalCase, snakeCase, paramCase, constantCase, capitalCase, dotCase, headerCase, noCase, pathCase } = require("./case");
const proxy = require("./proxy");
const { translateText } = require("./translate");
const { openSettings } = require("./settingsView");

const window = vscode.window;
const commands = vscode.commands;
const workspace = vscode.workspace;

const changeCaseMap = [
    { name: "camelCase", handle: camelCase, description: "驼峰 camelCase" },
    { name: "pascalCase", handle: pascalCase, description: "帕斯卡 PascalCase" },
    { name: "snakeCase", handle: snakeCase, description: "下划线 snake_case" },
    { name: "paramCase", handle: paramCase, description: "中划线 param-case" },
    { name: "constantCase", handle: constantCase, description: "常量 CONSTANT_CASE" },
    { name: "headerCase", handle: headerCase, description: "中划线(大) Header-Case" },
    { name: "capitalCase", handle: capitalCase, description: "分词(大) Capital Case" },
    { name: "noCase", handle: noCase, description: "分词(小) no case" },
    { name: "dotCase", handle: dotCase, description: "点分 dot.case" },
    { name: "pathCase", handle: pathCase, description: "路径 path/case" },
];

let statusBar;

let extensionContext;

function activate(context) {
    extensionContext = context;
    proxy.init(context);
    statusBar = window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBar);
    context.subscriptions.push(proxy.onDidChange(refreshStatus));
    context.subscriptions.push(
        workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("camelTranslation")) {
                refreshStatus();
            }
        }),
    );
    refreshStatus();

    context.subscriptions.push(commands.registerCommand("extension.camelTranslation", main));
    context.subscriptions.push(commands.registerCommand("extension.camelTranslation.contextMenu", () => typeTranslation("pascalCase")));
    context.subscriptions.push(commands.registerCommand("extension.camelTranslation.openSettings", () => openSettings(context)));
    context.subscriptions.push(commands.registerCommand("extension.camelTranslation.syncProxy", () => syncFromCommand(false)));
    context.subscriptions.push(commands.registerCommand("extension.camelTranslation.autoSelectProxy", () => syncFromCommand(true)));
    context.subscriptions.push(commands.registerCommand("extension.camelTranslation.switchProxy", switchProxy));
    changeCaseMap.forEach((item) => {
        context.subscriptions.push(commands.registerCommand(`extension.camelTranslation.${item.name}`, () => typeTranslation(item.name)));
    });
}

function deactivate() {}

function refreshStatus() {
    const status = proxy.getStatus();
    statusBar.text = status.text;
    statusBar.tooltip = status.tooltip;
    statusBar.command = status.command;
    statusBar.show();
}

async function askSubscriptionUrl() {
    const config = workspace.getConfiguration("camelTranslation");
    const current = String(config.get("proxy.subscriptionUrl", "") || "").trim();
    if (current) {
        return current;
    }
    const entered = await window.showInputBox({
        title: "机场订阅地址",
        prompt: "粘贴订阅链接。链接中的访问凭证会保存在本机设置里。",
        ignoreFocusOut: true,
        placeHolder: "https://example.com/subscribe?token=...",
    });
    return entered ? entered.trim() : "";
}

async function syncFromCommand(forceSelect) {
    const url = await askSubscriptionUrl();
    if (!url) {
        return;
    }
    const select = forceSelect || workspace.getConfiguration("camelTranslation").get("proxy.selection", "auto") === "auto";
    await runTask(() =>
        proxy.syncSubscription({
            subscriptionUrl: url,
            mode: "subscription",
            select,
        }),
    );
}

async function runTask(task) {
    try {
        await proxy.enqueue(task);
        const state = proxy.snapshot();
        if (state.lastError) {
            window.showWarningMessage(state.lastError);
        } else if (state.lastMessage) {
            window.showInformationMessage(state.lastMessage);
        }
    } catch (error) {
        window.showErrorMessage(error.message || "操作失败");
    }
}

async function vscodeSelect(word) {
    const items = changeCaseMap.map((item) => ({
        label: item.handle(word),
        description: item.description,
    }));
    const selection = await window.showQuickPick(items, {
        matchOnDescription: true,
        placeHolder: "选择替换形式",
    });
    return selection && selection.label;
}

async function translateSelection(srcText) {
    if (!srcText || !srcText.trim()) {
        return null;
    }
    if (/^[a-zA-Z\d\s\/\-\._]+$/.test(srcText)) {
        return srcText;
    }
    const config = workspace.getConfiguration("camelTranslation");
    const engine = config.get("translationEngine", "google");
    window.setStatusBarMessage("网络翻译中...", 3000);
    try {
        const proxyUrl = await proxy.resolveProxyUrl();
        try {
            return await translateText({
                engine,
                text: srcText,
                to: "en",
                proxyUrl,
                timeout: proxy.readTimeout(),
                credentials: {
                    appId: engine === "baidu" ? config.get("BaiDuKey", "") : config.get("YouDaoKey", ""),
                    secret: engine === "baidu" ? config.get("BaiDuSecret", "") : config.get("YouDaoSecret", ""),
                },
            });
        } catch (error) {
            const next = error.network ? proxy.peekNext(proxyUrl) : "";
            if (!next) {
                throw error;
            }
            const text = await translateText({
                engine,
                text: srcText,
                to: "en",
                proxyUrl: next,
                timeout: proxy.readTimeout(),
                credentials: {
                    appId: engine === "baidu" ? config.get("BaiDuKey", "") : config.get("YouDaoKey", ""),
                    secret: engine === "baidu" ? config.get("BaiDuSecret", "") : config.get("YouDaoSecret", ""),
                },
            });
            await proxy.commitSelection(next);
            return text;
        }
    } catch (error) {
        console.error(error);
        window.showErrorMessage(error.message || "翻译失败");
        return null;
    }
}

async function main() {
    const editor = window.activeTextEditor;
    if (!editor) {
        return;
    }
    for (const selection of editor.selections) {
        const selected = editor.document.getText(selection);
        const translated = await translateSelection(selected);
        if (!translated) {
            return;
        }
        const userSelected = await vscodeSelect(translated);
        if (!userSelected) {
            return;
        }
        await editor.edit((builder) => builder.replace(selection, userSelected));
    }
}

async function typeTranslation(type) {
    const changeCase = changeCaseMap.find((item) => item.name === type);
    const editor = window.activeTextEditor;
    if (!changeCase || !editor) {
        return;
    }
    for (const selection of editor.selections) {
        const selected = editor.document.getText(selection);
        const translated = await translateSelection(selected);
        if (!translated) {
            return;
        }
        await editor.edit((builder) => builder.replace(selection, changeCase.handle(translated)));
    }
}

async function switchProxy() {
    const mode = workspace.getConfiguration("camelTranslation").get("proxy.mode", "off");
    if (mode !== "subscription") {
        openSettings(extensionContext);
        return;
    }
    const state = proxy.snapshot();
    const items = [
        { label: "$(gear) 打开设置", action: "settings" },
        { label: "$(sync) 同步订阅", action: "sync" },
        { label: "$(zap) 自动选择最快节点", action: "auto" },
        { label: "节点", kind: vscode.QuickPickItemKind.Separator },
    ];
    state.nodes.forEach((node) => {
        items.push({
            label: node.name,
            description: node.usable ? (typeof node.latency === "number" ? `${node.latency} ms` : "未测速") : "不能直接使用",
            detail: `${node.type}  ${node.server}:${node.port}`,
            id: node.id,
            usable: node.usable,
            picked: node.id === state.selectedId,
        });
    });
    const picked = await window.showQuickPick(items, { placeHolder: "选择代理节点" });
    if (!picked) {
        return;
    }
    if (picked.action === "settings") {
        openSettings(extensionContext);
        return;
    }
    if (picked.action === "sync") {
        await runTask(() =>
            proxy.syncSubscription({
                select: workspace.getConfiguration("camelTranslation").get("proxy.selection", "auto") === "auto",
            }),
        );
        return;
    }
    if (picked.action === "auto") {
        await runTask(() => proxy.autoSelect());
        return;
    }
    if (!picked.usable) {
        window.showWarningMessage(`「${picked.label}」不能直接用来发请求。请选择 HTTP 或 SOCKS 节点，或改用手动代理。`);
        return;
    }
    try {
        await proxy.selectNode(picked.id);
    } catch (error) {
        window.showErrorMessage(error.message || "切换失败");
    }
}

module.exports = {
    activate,
    deactivate,
};
