const crypto = require("crypto");
const { parse } = require("yaml");

const SKIP_TYPES = new Set(["direct", "block", "dns", "selector", "urltest", "loadbalance", "reject", "pass", "compatible"]);
const MAX_NODES = 500;

function printableRatio(text) {
    if (!text) {
        return 0;
    }
    let ok = 0;
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 0xfffd)) {
            ok += 1;
        }
    }
    return ok / text.length;
}

function decodeBase64(input) {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
    return Buffer.from(normalized + "=".repeat(padLength), "base64").toString("utf8");
}

function mightBeBase64(text) {
    const compact = text.replace(/\s+/g, "");
    if (compact.length < 16 || compact.length % 4 === 1) {
        return false;
    }
    return /^[A-Za-z0-9+/_=-]+$/.test(compact);
}

function unwrap(raw) {
    let text = String(raw || "")
        .replace(/^\uFEFF/, "")
        .trim();
    for (let i = 0; i < 2; i += 1) {
        if (!mightBeBase64(text)) {
            break;
        }
        const decoded = decodeBase64(text.replace(/\s+/g, "")).trim();
        if (!decoded || decoded === text || printableRatio(decoded) < 0.85) {
            break;
        }
        text = decoded;
    }
    return text;
}

function formatHost(server) {
    if (server.startsWith("[") && server.endsWith("]")) {
        return server;
    }
    return server.includes(":") ? `[${server}]` : server;
}

function normalizeNode({ name, type, server, port, username, password, tls }) {
    const cleanType = String(type || "").toLowerCase();
    const cleanServer = String(server || "").trim();
    const cleanPort = Number(port);
    let scheme = cleanType === "socks" ? "socks5" : cleanType;
    if (scheme === "http" && tls) {
        scheme = "https";
    }
    const safeName = String(name || `${scheme || "节点"} ${cleanServer}:${cleanPort || ""}`)
        .trim()
        .slice(0, 80);
    const portOk = Number.isInteger(cleanPort) && cleanPort > 0 && cleanPort <= 65535;
    const serverOk = Boolean(cleanServer) && !/\s/.test(cleanServer);
    const usableType = scheme === "http" || scheme === "https" || scheme === "socks4" || scheme === "socks5";
    const usable = usableType && serverOk && portOk;
    let proxyUrl = "";
    if (usable) {
        const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@` : "";
        proxyUrl = `${scheme}://${auth}${formatHost(cleanServer)}:${cleanPort}`;
    }
    return {
        id: "",
        name: safeName || "未命名节点",
        type: scheme || cleanType || "unknown",
        server: cleanServer,
        port: portOk ? cleanPort : 0,
        usable,
        proxyUrl,
        latency: null,
        error: "",
    };
}

function parseHostPort(input) {
    const value = String(input || "")
        .split("?")[0]
        .split("/")[0];
    if (value.startsWith("[")) {
        const end = value.indexOf("]");
        return {
            server: value.slice(1, end),
            port: Number(value.slice(end + 2)),
        };
    }
    const index = value.lastIndexOf(":");
    if (index < 0) {
        return { server: value, port: 0 };
    }
    return {
        server: value.slice(0, index),
        port: Number(value.slice(index + 1)),
    };
}

function fragmentName(line) {
    const index = line.indexOf("#");
    if (index < 0) {
        return "";
    }
    try {
        return decodeURIComponent(line.slice(index + 1)).trim();
    } catch (error) {
        return line.slice(index + 1).trim();
    }
}

function fromHttpUri(line, name) {
    const hash = line.indexOf("#");
    const bare = hash >= 0 ? line.slice(0, hash) : line;
    let url;
    try {
        url = new URL(bare);
    } catch (error) {
        return null;
    }
    const scheme = url.protocol.replace(":", "");
    return normalizeNode({
        name: name || `${scheme} ${url.hostname}:${url.port}`,
        type: scheme,
        server: url.hostname,
        port: url.port,
        username: url.username,
        password: url.password,
    });
}

function fromSs(line, name) {
    const hash = line.indexOf("#");
    const body = (hash >= 0 ? line.slice(0, hash) : line).slice("ss://".length);
    let server = "";
    let port = 0;
    try {
        if (body.includes("@")) {
            const host = parseHostPort(body.slice(body.lastIndexOf("@") + 1));
            server = host.server;
            port = host.port;
        } else {
            const decoded = decodeBase64(body);
            const at = decoded.lastIndexOf("@");
            if (at >= 0) {
                const host = parseHostPort(decoded.slice(at + 1));
                server = host.server;
                port = host.port;
            }
        }
    } catch (error) {
        server = "";
    }
    return normalizeNode({ name: name || "Shadowsocks", type: "ss", server, port });
}

function fromVmess(line, name) {
    const hash = line.indexOf("#");
    const body = (hash >= 0 ? line.slice(0, hash) : line).slice("vmess://".length);
    let server = "";
    let port = 0;
    let label = name || "VMess";
    try {
        const data = JSON.parse(decodeBase64(body));
        label = name || data.ps || data.remark || label;
        server = data.add || data.host || "";
        port = Number(data.port || 0);
    } catch (error) {
        label = name || label;
    }
    return normalizeNode({ name: label, type: "vmess", server, port });
}

function fromGenericUri(line, type, name) {
    const hash = line.indexOf("#");
    const bare = hash >= 0 ? line.slice(0, hash) : line;
    let server = "";
    let port = 0;
    try {
        const url = new URL(bare);
        server = url.hostname;
        port = Number(url.port);
    } catch (error) {
        const body = bare.slice(bare.indexOf("://") + 3);
        const at = body.lastIndexOf("@");
        const host = parseHostPort(at >= 0 ? body.slice(at + 1) : body);
        server = host.server;
        port = host.port;
    }
    return normalizeNode({ name: name || type, type, server, port });
}

function fromUri(line) {
    const text = String(line || "").trim();
    if (!text || text.startsWith("#") || text.startsWith("//")) {
        return null;
    }
    const name = fragmentName(text);
    const scheme = text.slice(0, text.indexOf("://")).toLowerCase();
    if (!scheme) {
        return null;
    }
    if (["http", "https", "socks", "socks4", "socks5"].includes(scheme)) {
        return fromHttpUri(text, name);
    }
    if (scheme === "ss" || scheme === "shadowsocks") {
        return fromSs(text, name);
    }
    if (scheme === "vmess") {
        return fromVmess(text, name);
    }
    if (["vless", "trojan", "hysteria", "hysteria2", "hy2", "tuic", "ssr"].includes(scheme)) {
        const type = scheme === "hy2" ? "hysteria2" : scheme;
        return fromGenericUri(text, type, name);
    }
    return null;
}

function fromClashProxy(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
    }
    const type = String(item.type || "").toLowerCase();
    if (!type || SKIP_TYPES.has(type)) {
        return null;
    }
    return normalizeNode({
        name: item.name || item.tag,
        type,
        server: item.server,
        port: item.port,
        username: item.username || item.user || "",
        password: item.password || "",
        tls: Boolean(item.tls),
    });
}

function fromSingbox(item) {
    if (!item || typeof item !== "object") {
        return null;
    }
    const type = String(item.type || "").toLowerCase();
    if (!type || SKIP_TYPES.has(type)) {
        return null;
    }
    let mapped = type === "shadowsocks" ? "ss" : type;
    if (type === "socks") {
        mapped = String(item.version || "") === "4" ? "socks4" : "socks5";
    }
    return normalizeNode({
        name: item.tag || item.name,
        type: mapped,
        server: item.server,
        port: item.server_port || item.port,
        username: item.username || "",
        password: item.password || "",
    });
}

function nodesFromDocument(doc) {
    if (Array.isArray(doc)) {
        return doc.flatMap((item) => {
            if (typeof item === "string") {
                const node = fromUri(item);
                return node ? [node] : [];
            }
            const node = fromClashProxy(item);
            return node ? [node] : [];
        });
    }
    if (!doc || typeof doc !== "object") {
        return [];
    }
    if (Array.isArray(doc.proxies)) {
        return doc.proxies.map(fromClashProxy).filter(Boolean);
    }
    if (Array.isArray(doc.outbounds)) {
        return doc.outbounds.map(fromSingbox).filter(Boolean);
    }
    return [];
}

function parseStructured(text) {
    const source = text.trim();
    if (source.startsWith("{") || source.startsWith("[")) {
        try {
            return nodesFromDocument(JSON.parse(source));
        } catch (error) {
            return [];
        }
    }
    try {
        return nodesFromDocument(parse(source, { maxAliasCount: 100 }));
    } catch (error) {
        return [];
    }
}

function parseLines(text) {
    return text.split(/\r?\n/).map(fromUri).filter(Boolean);
}

function dedupe(nodes) {
    const seen = new Set();
    const result = [];
    for (const node of nodes) {
        const key = [node.type, node.server, node.port, node.name].join("|");
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(node);
    }
    return result;
}

function assignIds(nodes) {
    const seen = new Map();
    return nodes.map((node) => {
        const base = crypto.createHash("sha256").update([node.type, node.server, node.port, node.name].join("|")).digest("hex").slice(0, 12);
        const count = seen.get(base) || 0;
        seen.set(base, count + 1);
        return { ...node, id: count ? `${base}-${count}` : base };
    });
}

function parseSubscription(raw) {
    const text = unwrap(raw);
    if (!text || /<html[\s>]/i.test(text) || /<!doctype html/i.test(text)) {
        return [];
    }
    const structured = parseStructured(text);
    const nodes = structured.length ? structured : parseLines(text);
    return assignIds(dedupe(nodes)).slice(0, MAX_NODES);
}

function chooseFastest(nodes) {
    const ready = nodes.filter((node) => node.usable && Number.isFinite(node.latency));
    ready.sort((left, right) => left.latency - right.latency || String(left.name).localeCompare(String(right.name), "zh"));
    return ready[0] || null;
}

function publicNode(node) {
    return {
        id: node.id,
        name: node.name,
        type: node.type,
        server: node.server,
        port: node.port,
        usable: node.usable,
        latency: Number.isFinite(node.latency) ? node.latency : null,
        error: node.error || "",
    };
}

module.exports = {
    chooseFastest,
    parseSubscription,
    publicNode,
};
