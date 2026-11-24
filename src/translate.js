const crypto = require("crypto");
const { HttpError, request } = require("./net");

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_UA = `${BROWSER_UA} Edg/131.0.0.0`;

const ENGINES = {
    google: { label: "谷歌", host: "translate.googleapis.com" },
    googleCN: { label: "谷歌中国", host: "translate.google.cn" },
    bing: { label: "必应" },
    baidu: { label: "百度" },
    youdao: { label: "有道" },
};

let bingToken = { value: "", expiresAt: 0 };

function clearTranslateCache() {
    bingToken = { value: "", expiresAt: 0 };
}

function engineLabel(engine) {
    return (ENGINES[engine] && ENGINES[engine].label) || engine;
}

async function sendRequest(url, options, transport) {
    if (transport) {
        return transport(url, options);
    }
    return request(url, options);
}

async function readResponse(response, label) {
    const status = response.status || 0;
    if (status === 407 || status >= 500) {
        throw new HttpError(`${label}暂时不可用（HTTP ${status}）`, { network: true, status });
    }
    return response.body || Buffer.alloc(0);
}

function parseGoogle(body) {
    const text = body.toString("utf8").replace(/^\)\]\}',?\s*/, "");
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new HttpError("谷歌翻译返回了无法识别的内容");
    }
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
        throw new HttpError("谷歌翻译没有返回结果");
    }
    const translated = data[0].map((part) => (Array.isArray(part) ? part[0] || "" : "")).join("");
    if (!translated) {
        throw new HttpError("谷歌翻译没有返回结果");
    }
    return translated;
}

async function translateGoogle(host, text, to, options) {
    const url = new URL(`https://${host}/translate_a/single`);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", to);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);
    const response = await sendRequest(
        url.toString(),
        {
            method: "GET",
            userAgent: BROWSER_UA,
            proxy: options.proxyUrl,
            timeout: options.timeout,
            headers: { accept: "application/json,text/plain,*/*" },
        },
        options.send,
    );
    const body = await readResponse(response, "谷歌翻译");
    if (response.status && (response.status < 200 || response.status >= 300)) {
        throw new HttpError(`谷歌翻译请求失败（HTTP ${response.status}）`, { status: response.status });
    }
    return parseGoogle(body);
}

async function fetchBingToken(options) {
    if (bingToken.value && bingToken.expiresAt > Date.now()) {
        return bingToken.value;
    }
    const response = await sendRequest(
        "https://edge.microsoft.com/translate/auth",
        {
            method: "GET",
            userAgent: EDGE_UA,
            proxy: options.proxyUrl,
            timeout: options.timeout,
            headers: { accept: "text/plain" },
        },
        options.send,
    );
    const body = await readResponse(response, "必应翻译");
    if (response.status && response.status !== 200) {
        throw new HttpError(`必应授权失败（HTTP ${response.status}）`, {
            network: response.status >= 500,
            status: response.status,
        });
    }
    const token = body.toString("utf8").trim();
    if (!token) {
        throw new HttpError("必应授权失败");
    }
    bingToken = { value: token, expiresAt: Date.now() + 8 * 60 * 1000 };
    return token;
}

function parseBing(body) {
    let data;
    try {
        data = JSON.parse(body.toString("utf8"));
    } catch (error) {
        throw new HttpError("必应翻译返回了无法识别的内容");
    }
    const translated = data && data[0] && data[0].translations && data[0].translations[0] && data[0].translations[0].text;
    if (!translated) {
        throw new HttpError("必应翻译没有返回结果");
    }
    return translated;
}

async function translateBing(text, to, options, allowRefresh) {
    const token = await fetchBingToken(options);
    const url = new URL("https://api.cognitive.microsofttranslator.com/translate");
    url.searchParams.set("api-version", "3.0");
    url.searchParams.set("to", to);
    const response = await sendRequest(
        url.toString(),
        {
            method: "POST",
            userAgent: EDGE_UA,
            proxy: options.proxyUrl,
            timeout: options.timeout,
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify([{ Text: text }]),
        },
        options.send,
    );
    if (response.status === 401 && allowRefresh) {
        clearTranslateCache();
        return translateBing(text, to, options, false);
    }
    const body = await readResponse(response, "必应翻译");
    if (response.status && (response.status < 200 || response.status >= 300)) {
        throw new HttpError(`必应翻译请求失败（HTTP ${response.status}）`, { status: response.status });
    }
    return parseBing(body);
}

function baiduSign(appid, text, salt, secret) {
    return crypto
        .createHash("md5")
        .update(appid + text + salt + secret)
        .digest("hex");
}

function parseBaidu(body) {
    let data;
    try {
        data = JSON.parse(body.toString("utf8"));
    } catch (error) {
        throw new HttpError("百度翻译返回了无法识别的内容");
    }
    if (data.error_code || data.error_msg) {
        throw new HttpError(`百度翻译失败：${data.error_msg || data.error_code}`);
    }
    const translated = data.trans_result && data.trans_result[0] && data.trans_result[0].dst;
    if (!translated) {
        throw new HttpError("百度翻译没有返回结果");
    }
    return translated;
}

async function translateBaidu(text, to, credentials, options) {
    const appid = String(credentials.appId || "").trim();
    const secret = String(credentials.secret || "").trim();
    if (!appid) {
        throw new HttpError("请先配置百度应用 ID");
    }
    if (!secret) {
        throw new HttpError("请先配置百度应用密钥");
    }
    const salt = Date.now().toString();
    const body = new URLSearchParams({
        q: text,
        from: "auto",
        to,
        appid,
        salt,
        sign: baiduSign(appid, text, salt, secret),
    }).toString();
    const response = await sendRequest(
        "https://fanyi-api.baidu.com/api/trans/vip/translate",
        {
            method: "POST",
            proxy: options.proxyUrl,
            timeout: options.timeout,
            headers: {
                "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                accept: "application/json",
            },
            body,
        },
        options.send,
    );
    const responseBody = await readResponse(response, "百度翻译");
    if (response.status && (response.status < 200 || response.status >= 300)) {
        throw new HttpError(`百度翻译请求失败（HTTP ${response.status}）`, { status: response.status });
    }
    return parseBaidu(responseBody);
}

function truncateQuery(text) {
    if (text.length <= 20) {
        return text;
    }
    return text.slice(0, 10) + text.length + text.slice(-10);
}

function youdaoSign(appKey, text, salt, curtime, secret) {
    return crypto
        .createHash("sha256")
        .update(appKey + truncateQuery(text) + salt + curtime + secret)
        .digest("hex");
}

function parseYoudao(body) {
    let data;
    try {
        data = JSON.parse(body.toString("utf8"));
    } catch (error) {
        throw new HttpError("有道翻译返回了无法识别的内容");
    }
    if (String(data.errorCode) !== "0") {
        throw new HttpError(`有道翻译失败（错误码 ${data.errorCode}）`);
    }
    const translated = data.translation && data.translation[0];
    if (!translated) {
        throw new HttpError("有道翻译没有返回结果");
    }
    return translated;
}

async function translateYoudao(text, to, credentials, options) {
    const appKey = String(credentials.appId || "").trim();
    const secret = String(credentials.secret || "").trim();
    if (!appKey) {
        throw new HttpError("请先配置有道应用 ID");
    }
    if (!secret) {
        throw new HttpError("请先配置有道应用密钥");
    }
    const salt = crypto.randomUUID();
    const curtime = Math.floor(Date.now() / 1000).toString();
    const body = new URLSearchParams({
        q: text,
        from: "auto",
        to,
        appKey,
        salt,
        sign: youdaoSign(appKey, text, salt, curtime, secret),
        signType: "v3",
        curtime,
    }).toString();
    const response = await sendRequest(
        "https://openapi.youdao.com/api",
        {
            method: "POST",
            proxy: options.proxyUrl,
            timeout: options.timeout,
            headers: {
                "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                accept: "application/json",
            },
            body,
        },
        options.send,
    );
    const responseBody = await readResponse(response, "有道翻译");
    if (response.status && (response.status < 200 || response.status >= 300)) {
        throw new HttpError(`有道翻译请求失败（HTTP ${response.status}）`, { status: response.status });
    }
    return parseYoudao(responseBody);
}

async function translateText(options) {
    const engine = options.engine;
    const text = options.text;
    const to = options.to || "en";
    const meta = ENGINES[engine];
    if (!meta) {
        throw new HttpError(`未知翻译引擎：${engine}`);
    }
    if (engine === "google" || engine === "googleCN") {
        return translateGoogle(meta.host, text, to, options);
    }
    if (engine === "bing") {
        return translateBing(text, to, options, true);
    }
    if (engine === "baidu") {
        return translateBaidu(text, to, options.credentials || {}, options);
    }
    return translateYoudao(text, to, options.credentials || {}, options);
}

module.exports = {
    ENGINES,
    baiduSign,
    clearTranslateCache,
    engineLabel,
    parseBaidu,
    parseBing,
    parseGoogle,
    parseYoudao,
    translateText,
    truncateQuery,
    youdaoSign,
};
