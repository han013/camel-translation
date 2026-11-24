const { test } = require("node:test");
const assert = require("node:assert/strict");
const { camelCase, pascalCase, snakeCase, paramCase, constantCase, capitalCase, dotCase, headerCase, noCase, pathCase } = require("../../src/case");

test("命名转换与原来的 change-case 结果一致", () => {
    assert.equal(camelCase("foo bar"), "fooBar");
    assert.equal(camelCase("foo-bar"), "fooBar");
    assert.equal(camelCase("FooBar"), "fooBar");
    assert.equal(camelCase("HTMLParser"), "htmlParser");
    assert.equal(camelCase("version 2"), "version_2");
    assert.equal(pascalCase("foo bar"), "FooBar");
    assert.equal(pascalCase("HTMLParser"), "HtmlParser");
    assert.equal(pascalCase("version 2"), "Version_2");
    assert.equal(snakeCase("fooBar"), "foo_bar");
    assert.equal(snakeCase("HTMLParser"), "html_parser");
    assert.equal(paramCase("fooBar"), "foo-bar");
    assert.equal(constantCase("fooBar"), "FOO_BAR");
    assert.equal(constantCase("HTMLParser"), "HTML_PARSER");
    assert.equal(capitalCase("fooBar"), "Foo Bar");
    assert.equal(dotCase("fooBar"), "foo.bar");
    assert.equal(headerCase("fooBar"), "Foo-Bar");
    assert.equal(noCase("fooBar"), "foo bar");
    assert.equal(pathCase("fooBar"), "foo/bar");
    assert.equal(camelCase("---"), "");
});
