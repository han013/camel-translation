const vscode = require('vscode');
const window = vscode.window
const commands = vscode.commands
const workspace = vscode.workspace

const { camelCase, paramCase, pascalCase, snakeCase, constantCase, capitalCase, dotCase, headerCase, noCase, pathCase } = require('change-case');

const { GoogleTranslator } = require('@translate-tools/core/translators/GoogleTranslator');
const google = new GoogleTranslator();
const { translate } = require('bing-translate-api');
const googleCN = require('google-translate-api-cn');
const Youdao = require("youdao-fanyi");

const changeCaseMap = [
    { name: "camelCase", handle: camelCase, description: "camelCase 驼峰(小)" },
    { name: "pascalCase", handle: pascalCase, description: "pascalCase 驼峰(大)" },
    { name: "snakeCase", handle: snakeCase, description: "snakeCase 下划线" },
    { name: "paramCase", handle: paramCase, description: "paramCase 中划线(小)" },
    { name: "headerCase", handle: headerCase, description: "headerCase 中划线(大)" },
    { name: "noCase", handle: noCase, description: "noCase 分词(小)" },
    { name: "capitalCase", handle: capitalCase, description: "capitalCase 分词(大)" },
    { name: "dotCase", handle: dotCase, description: "dotCase 对象属性" },
    { name: "pathCase", handle: pathCase, description: "pathCase 文件路径" },
    { name: "constantCase", handle: constantCase, description: "constantCase 常量" },
];

function activate (context) {
    const translation = commands.registerCommand("extension.camelTranslation", main);
    context.subscriptions.push(translation);
    changeCaseMap.forEach((item) => {
        context.subscriptions.push(
            commands.registerCommand(`extension.camelTranslation.${item.name}`, () => typeTranslation(item.name))
        );
    });
}
function deactivate () { }

module.exports = {
    activate,
    deactivate
}

/**
 * 用户选择选择转换形式
 * @param word 需要转换的单词
 * @return  用户选择
 */
async function vscodeSelect (word) {
    const items = changeCaseMap.map((item) => ({
        label: item.handle(word),
        description: item.description,
    }));
    const opts = { matchOnDescription: true, placeHolder: "choose replace 选择替换" };
    const selections = await window.showQuickPick(items, opts);
    if (!selections) {
        return;
    }
    return selections.label;
}

/**
 * 翻译
 */
async function getTranslateResult (srcText) {
    let engine = workspace.getConfiguration("camelTranslation").translationEngine;
    // 正则快速判断英文
    if (/^[a-zA-Z\d\s\/\-\._]+$/.test(srcText)) {
        return srcText;
    }
    try {
        // window.showQuickPick([{ label: "网络翻译中..." }]);
        window.setStatusBarMessage('网络翻译中...',3000)
        console.log('使用%s翻译内容:%s', engine, srcText);
        const res = await doTranslate(engine, srcText, "en");
        const result = res?.text || null;
        return result;
    } catch (error) {
        console.error(error);
        window.showInformationMessage(`${engine}翻译异常,请检查网络或稍后重试 ${JSON.stringify(error)}`);
        return null;
    }
}
async function main () {
    // 获取编辑器
    const editor = window.activeTextEditor;
    if (!editor) {
        return;
    }
    // 获取选中文字
    for (const selection of editor.selections) {
        const selected = editor.document.getText(selection);
        // 获取翻译结果
        const translated = await getTranslateResult(selected);
        if (!translated) {
            return;
        }
        // 组装选项
        const userSelected = await vscodeSelect(translated);
        // 用户选中
        if (!userSelected) {
            return;
        }
        // 替换文案
        editor.edit((builder) => builder.replace(selection, userSelected));
    }
}
const typeTranslation = async (type) => {
    const changeCase = changeCaseMap.find((item) => item.name === type);
    if (!changeCase) {
        return;
    }
    // 获取编辑器
    const editor = window.activeTextEditor;
    if (!editor) {
        return;
    }
    // 获取选中文字
    for (const selection of editor.selections) {
        const selected = editor.document.getText(selection);
        // 获取翻译结果
        const translated = await getTranslateResult(selected);
        if (!translated) {
            return;
        }
        // 替换文案
        editor.edit((builder) => builder.replace(selection, changeCase.handle(translated)));
    }
};


async function doTranslate (type, src, to) {
    console.log('使用%s翻译', type);
    if (type == 'google') {
        const res = await google.translate(src, 'auto', to);
        return { text: res };
    } else if (type == 'bing') {
        const res = await translate(src, null, to, true);
        return { text: res.translation };
    } else if (type == 'googleCN') {
        const res = await googleCN(src, { to: to });
        return { text: res.text };
    } else if (type == 'baidu') {
        const BaiDuKey = workspace.getConfiguration("camelTranslation").BaiDuKey;
        const BaiDuSecret = workspace.getConfiguration("camelTranslation").BaiDuSecret;
        if (!BaiDuKey) {
            window.showErrorMessage("请先配置百度应用ID");
            return;
        }
        if (!BaiDuSecret) {
            window.showErrorMessage("请先配置百度应用秘钥");
            return;
        }
        const baiduTranslate = require('baidu-translate')(BaiDuKey, BaiDuSecret);
        const res = await baiduTranslate(src);
        if (res.error_msg) {
            window.showErrorMessage(`请检查配置 ${res.error_msg}`);
            return;
        }
        return { text: res.trans_result[0].dst };
    } else if (type == 'youdao') {
        const YouDaoKey = workspace.getConfiguration("camelTranslation").YouDaoKey;
        const YouDaoSecret = workspace.getConfiguration("camelTranslation").YouDaoSecret;
        if (!YouDaoKey) {
            window.showErrorMessage("请先配置有道应用ID");
            return;
        }
        if (!YouDaoSecret) {
            window.showErrorMessage("请先配置有道应用秘钥");
            return;
        }
        const yd = Youdao({
            appkey: YouDaoKey,
            secret: YouDaoSecret,
        });
        const res = await yd(src);
        if (res.errorCode !== '0') {
            window.showErrorMessage(`错误码： ${res.errorCode}`);
            return ;
        }
        return { text: res.translation[0] };
    }
}