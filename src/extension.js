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

function activate(context) {
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
        const proxyUrl = proxy.resolveProxyUrl();
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

module.exports = {
    activate,
    deactivate,
};
