import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const popupSource = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const match = popupSource.match(
  /async function loadCategoryMembers\(categoryId\) \{[\s\S]*?\n\}\n\nasync function loadFollowings/
);

assert.ok(match, "无法从 popup.js 提取 loadCategoryMembers");

let renderCount = 0;
const context = vm.createContext({
  state: {
    categoryMembers: new Map([["0", new Set(["10001"])]]),
    categoryLoading: false,
    currentPage: 1
  },
  elements: { categorySelect: { value: "group:0" } },
  render: () => { renderCount += 1; },
  setNotice: () => {},
  sendApi: () => { throw new Error("缓存命中时不应发送请求"); },
  Map,
  Set,
  Number,
  String,
  Array,
  Error
});

vm.runInContext(
  `${match[0].replace(/\n\nasync function loadFollowings$/, "")}\nthis.loadCategoryMembers = loadCategoryMembers;`,
  context
);

await context.loadCategoryMembers("0");

assert.equal(renderCount, 1, "切换到已缓存分组时应立即重新渲染列表");

console.log("category switch regression passed");
