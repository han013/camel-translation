/**
 * 命名转换与 change-case 4.x 保持同一套分词规则，
 * 这样已有快捷键的结果不会因为去掉旧依赖而变化。
 */

const SPLIT_PATTERNS = [/([a-z0-9])([A-Z])/g, /([A-Z])([A-Z][a-z])/g];
const STRIP_PATTERN = /[^A-Z0-9]+/gi;

function replaceWith(input, pattern, value) {
    if (pattern instanceof RegExp) {
        return input.replace(pattern, value);
    }
    return pattern.reduce((text, item) => text.replace(item, value), input);
}

function lowerCase(input) {
    return input.toLowerCase();
}

function upperCase(input) {
    return input.toUpperCase();
}

function pascalCaseTransform(input, index) {
    const firstChar = input.charAt(0);
    const rest = input.slice(1).toLowerCase();
    if (index > 0 && firstChar >= "0" && firstChar <= "9") {
        return `_${firstChar}${rest}`;
    }
    return `${firstChar.toUpperCase()}${rest}`;
}

function camelCaseTransform(input, index) {
    if (index === 0) {
        return input.toLowerCase();
    }
    return pascalCaseTransform(input, index);
}

function capitalCaseTransform(input) {
    const lower = input.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function noCase(input, options = {}) {
    const transform = options.transform || lowerCase;
    const delimiter = options.delimiter === undefined ? " " : options.delimiter;
    const source = input == null ? "" : String(input);
    let result = replaceWith(
        source,
        SPLIT_PATTERNS.map((item) => new RegExp(item.source, "g")),
        "$1\0$2",
    );
    result = replaceWith(result, new RegExp(STRIP_PATTERN.source, "gi"), "\0");
    let start = 0;
    let end = result.length;
    while (result.charAt(start) === "\0") {
        start += 1;
    }
    while (result.charAt(end - 1) === "\0") {
        end -= 1;
    }
    return result.slice(start, end).split("\0").map(transform).join(delimiter);
}

function camelCase(input) {
    return noCase(input, { delimiter: "", transform: camelCaseTransform });
}

function pascalCase(input) {
    return noCase(input, { delimiter: "", transform: pascalCaseTransform });
}

function snakeCase(input) {
    return noCase(input, { delimiter: "_" });
}

function paramCase(input) {
    return noCase(input, { delimiter: "-" });
}

function constantCase(input) {
    return noCase(input, { delimiter: "_", transform: upperCase });
}

function capitalCase(input) {
    return noCase(input, { delimiter: " ", transform: capitalCaseTransform });
}

function dotCase(input) {
    return noCase(input, { delimiter: "." });
}

function headerCase(input) {
    return noCase(input, { delimiter: "-", transform: capitalCaseTransform });
}

function pathCase(input) {
    return noCase(input, { delimiter: "/" });
}

module.exports = {
    camelCase,
    pascalCase,
    snakeCase,
    paramCase,
    constantCase,
    capitalCase,
    dotCase,
    headerCase,
    noCase,
    pathCase,
};
