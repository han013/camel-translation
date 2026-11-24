const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chooseFastest, parseSubscription } = require("../../src/subscription");

test("解析 Clash 订阅，只把 HTTP 和 SOCKS 当作可用节点", () => {
    const nodes = parseSubscription(`
proxies:
  - name: 香港 HTTP
    type: http
    server: 1.2.3.4
    port: 8080
    username: user
    password: "p@ss"
  - name: 日本 SOCKS
    type: socks5
    server: 5.6.7.8
    port: 1080
  - name: 美国 VMESS
    type: vmess
    server: 9.9.9.9
    port: 443
    uuid: secret-id
`);
    assert.equal(nodes.length, 3);
    assert.equal(nodes[0].usable, true);
    assert.equal(nodes[0].proxyUrl, "http://user:p%40ss@1.2.3.4:8080");
    assert.equal(nodes[1].type, "socks5");
    assert.equal(nodes[1].proxyUrl, "socks5://5.6.7.8:1080");
    assert.equal(nodes[2].usable, false);
    assert.equal(nodes[2].proxyUrl, "");
    assert.equal(JSON.stringify(nodes[2]).includes("secret-id"), false);
});

test("解析 Base64 分享链接", () => {
    const vmess = Buffer.from(JSON.stringify({ ps: "美国", add: "10.0.0.2", port: "443", id: "hidden" })).toString("base64");
    const raw = ["socks5://user:pass@10.0.0.1:1080#香港", `vmess://${vmess}`].join("\n");
    const nodes = parseSubscription(Buffer.from(raw).toString("base64"));
    assert.equal(nodes.length, 2);
    const socks = nodes.find((node) => node.type === "socks5");
    const blocked = nodes.find((node) => node.type === "vmess");
    assert.equal(socks.name, "香港");
    assert.equal(socks.usable, true);
    assert.equal(socks.proxyUrl, "socks5://user:pass@10.0.0.1:1080");
    assert.equal(blocked.name, "美国");
    assert.equal(blocked.usable, false);
    assert.equal(JSON.stringify(blocked).includes("hidden"), false);
});

test("解析 Sing-box 出站", () => {
    const nodes = parseSubscription(
        JSON.stringify({
            outbounds: [
                { type: "socks", tag: "本地", server: "127.0.0.1", server_port: 7891, version: "5" },
                { type: "direct", tag: "直连" },
                { type: "vmess", tag: "远端", server: "8.8.8.8", server_port: 443 },
            ],
        }),
    );
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].proxyUrl, "socks5://127.0.0.1:7891");
    assert.equal(nodes[1].usable, false);
});

test("网页内容不会被当成节点", () => {
    assert.deepEqual(parseSubscription("<!DOCTYPE html><html><body>login</body></html>"), []);
});

test("自动选择延迟最低的可用节点", () => {
    const picked = chooseFastest([
        { id: "a", name: "慢", usable: true, latency: 300 },
        { id: "b", name: "不可用", usable: false, latency: 10 },
        { id: "c", name: "快", usable: true, latency: 80 },
    ]);
    assert.equal(picked.id, "c");
});
