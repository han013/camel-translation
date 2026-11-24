const http = require("http");
const https = require("https");
const zlib = require("zlib");

const DEFAULT_UA = "camel-translation";
const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks4:", "socks5:"]);

class HttpError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "HttpError";
        this.network = Boolean(options.network);
        this.status = options.status || 0;
    }
}

function inflateBuffer(buffer, encoding) {
    const enc = String(encoding || "").toLowerCase();
    if (enc.includes("gzip")) {
        return zlib.gunzipSync(buffer);
    }
    if (enc.includes("deflate")) {
        try {
            return zlib.inflateSync(buffer);
        } catch {
            return zlib.inflateRawSync(buffer);
        }
    }
    return buffer;
}

function hostHint(error) {
    const address = error && (error.address || error.hostname);
    if (!address) {
        return "";
    }
    return error.port ? `（${address}:${error.port}）` : `（${address}）`;
}

function asNetworkError(error) {
    if (error instanceof HttpError) {
        return error;
    }
    if (error && error.message === "请求超时") {
        return new HttpError("请求超时", { network: true });
    }
    if (error && error.message === "响应内容过大") {
        return new HttpError("响应内容过大", { network: true });
    }
    const known = {
        ETIMEDOUT: "请求超时",
        ECONNRESET: "连接被重置",
        ECONNREFUSED: "连接被拒绝",
        ENOTFOUND: "域名无法解析",
        EAI_AGAIN: "域名暂时无法解析",
        EHOSTUNREACH: "主机不可达",
        EPROTO: "连接协议错误",
    };
    const code = error && error.code;
    const message = known[code] || "网络连接失败";
    return new HttpError(`${message}${hostHint(error)}`, { network: true });
}

function normalizeProxyUrl(value) {
    const text = String(value || "").trim();
    if (!text) {
        throw new HttpError("请先填写代理地址");
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    let url;
    try {
        url = new URL(withScheme);
    } catch (error) {
        throw new HttpError("代理地址格式不正确");
    }
    if (!ALLOWED_PROXY_PROTOCOLS.has(url.protocol)) {
        throw new HttpError("只支持 http、https、socks5、socks4 代理");
    }
    if (!url.hostname || !url.port) {
        throw new HttpError("代理地址需要包含主机和端口");
    }
    const auth = url.username || url.password ? `${encodeUserInfo(url.username)}:${encodeUserInfo(url.password)}@` : "";
    return `${url.protocol}//${auth}${url.host}`;
}

function encodeUserInfo(value) {
    if (!value) {
        return "";
    }
    try {
        return encodeURIComponent(decodeURIComponent(value));
    } catch {
        return encodeURIComponent(value);
    }
}

function assertHttpUrl(value, label) {
    const text = String(value || "").trim();
    let url;
    try {
        url = new URL(text);
    } catch (error) {
        throw new HttpError(`${label}格式不正确`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new HttpError(`${label}只支持 http 或 https`);
    }
    return text;
}

function sanitizeError(error) {
    const message = error && error.message ? error.message : "请求失败";
    return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "链接").slice(0, 180);
}

let agentModules;

function loadAgentModules() {
    if (!agentModules) {
        agentModules = Promise.all([import("https-proxy-agent"), import("socks-proxy-agent")]).then(([httpAgent, socksAgent]) => ({
            HttpsProxyAgent: httpAgent.HttpsProxyAgent,
            SocksProxyAgent: socksAgent.SocksProxyAgent,
        }));
    }
    return agentModules;
}

async function createAgent(proxyUrl) {
    const normalized = normalizeProxyUrl(proxyUrl);
    const modules = await loadAgentModules();
    const protocol = new URL(normalized).protocol;
    if (protocol.startsWith("socks")) {
        return new modules.SocksProxyAgent(normalized);
    }
    return new modules.HttpsProxyAgent(normalized);
}

function destroyAgent(agent) {
    if (agent && typeof agent.destroy === "function") {
        agent.destroy();
    }
}

function httpRequest(urlString, options = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error instanceof HttpError ? error : asNetworkError(error));
        };
        const succeed = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };

        let url;
        try {
            url = new URL(urlString);
        } catch (error) {
            fail(new HttpError("请求地址无效"));
            return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            fail(new HttpError("只允许 http 或 https 请求"));
            return;
        }

        const method = options.method || "GET";
        const headers = {
            "user-agent": options.userAgent || DEFAULT_UA,
            "accept-encoding": "gzip, deflate",
            ...options.headers,
        };
        const lib = url.protocol === "http:" ? http : https;
        const req = lib.request(
            url,
            {
                method,
                headers,
                agent: options.agent,
                timeout: options.timeout || 15000,
            },
            (res) => {
                const status = res.statusCode || 0;
                const location = res.headers.location;
                if (location && [301, 302, 303, 307, 308].includes(status) && redirects < 3 && options.followRedirects !== false) {
                    res.resume();
                    let next;
                    try {
                        next = new URL(location, url);
                    } catch (error) {
                        fail(new HttpError("重定向地址无效", { network: true, status }));
                        return;
                    }
                    if (next.protocol !== "http:" && next.protocol !== "https:") {
                        fail(new HttpError("重定向到了不支持的地址", { network: true, status }));
                        return;
                    }
                    const nextHeaders = { ...options.headers };
                    if (next.host !== url.host) {
                        delete nextHeaders.authorization;
                        delete nextHeaders.Authorization;
                    }
                    const switchToGet = status === 301 || status === 302 || status === 303;
                    httpRequest(
                        next.toString(),
                        {
                            ...options,
                            method: switchToGet ? "GET" : method,
                            headers: nextHeaders,
                            body: switchToGet ? undefined : options.body,
                        },
                        redirects + 1,
                    ).then(succeed, fail);
                    return;
                }

                const chunks = [];
                let size = 0;
                const maxBytes = options.maxBytes || 1000000;
                res.on("data", (chunk) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        req.destroy(new Error("响应内容过大"));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    try {
                        const body = inflateBuffer(Buffer.concat(chunks), res.headers["content-encoding"]);
                        succeed({ status, headers: res.headers, body });
                    } catch (error) {
                        fail(new HttpError("响应内容无法解压", { network: true, status }));
                    }
                });
            },
        );

        req.on("timeout", () => req.destroy(new Error("请求超时")));
        req.on("error", fail);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

async function request(url, options = {}) {
    const agent = options.proxy ? await createAgent(options.proxy) : undefined;
    try {
        return await httpRequest(url, { ...options, agent });
    } finally {
        destroyAgent(agent);
    }
}

module.exports = {
    HttpError,
    assertHttpUrl,
    createAgent,
    destroyAgent,
    httpRequest,
    normalizeProxyUrl,
    request,
    sanitizeError,
};
