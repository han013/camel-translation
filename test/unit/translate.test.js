const http = require("http");
const zlib = require("zlib");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HttpError, createAgent, httpRequest, normalizeProxyUrl } = require("../../src/net");
const { baiduSign, clearTranslateCache, parseGoogle, translateText, youdaoSign } = require("../../src/translate");

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
}

test("手动代理只接受带端口的 http 和 socks 地址", () => {
    assert.equal(normalizeProxyUrl("127.0.0.1:7890"), "http://127.0.0.1:7890");
    assert.equal(normalizeProxyUrl("socks5://user:p%40ss@10.0.0.8:1080"), "socks5://user:p%40ss@10.0.0.8:1080");
    assert.throws(() => normalizeProxyUrl("file:///tmp/proxy"), HttpError);
    assert.throws(() => normalizeProxyUrl("http://example.com"), HttpError);
    assert.throws(() => normalizeProxyUrl("javascript:alert(1)"), HttpError);
});

test("可以构造代理 agent", async () => {
    const agent = await createAgent("http://127.0.0.1:9");
    assert.equal(typeof agent.destroy, "function");
    agent.destroy();
});

test("请求能读取普通响应和 gzip 响应", async () => {
    const server = http.createServer((req, res) => {
        if (req.url === "/gzip") {
            const body = zlib.gzipSync(Buffer.from('{"ok":true}'));
            res.writeHead(200, { "content-encoding": "gzip" });
            res.end(body);
            return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });
    const port = await listen(server);
    try {
        const plain = await httpRequest(`http://127.0.0.1:${port}/`);
        assert.equal(plain.status, 200);
        assert.equal(plain.body.toString(), "ok");
        const packed = await httpRequest(`http://127.0.0.1:${port}/gzip`);
        assert.equal(packed.body.toString(), '{"ok":true}');
    } finally {
        server.close();
    }
});

test("翻译结果解析和签名", async () => {
    assert.equal(parseGoogle(Buffer.from('[[["Hello","你好"]]]')), "Hello");
    assert.equal(parseGoogle(Buffer.from('[[["Hello ","你好"],["world","世界"]]]')), "Hello world");
    assert.equal(baiduSign("id", "你好", "1", "secret"), require("crypto").createHash("md5").update("id你好1secret").digest("hex"));
    assert.equal(youdaoSign("app", "你好", "salt", "100", "secret").length, 64);

    clearTranslateCache();
    const google = await translateText({
        engine: "google",
        text: "你好",
        send: async (url) => {
            assert.match(url, /translate\.googleapis\.com/);
            return { status: 200, body: Buffer.from('[[["Hello","你好"]]]') };
        },
    });
    assert.equal(google, "Hello");

    const baidu = await translateText({
        engine: "baidu",
        text: "你好",
        credentials: { appId: "id", secret: "secret" },
        send: async (_url, options) => {
            assert.match(options.body, /sign=/);
            return { status: 200, body: Buffer.from(JSON.stringify({ trans_result: [{ dst: "Hello" }] })) };
        },
    });
    assert.equal(baidu, "Hello");

    await assert.rejects(() => translateText({ engine: "youdao", text: "你好", credentials: {}, send: async () => ({ status: 200, body: Buffer.alloc(0) }) }), /请先配置有道应用 ID/);
});
