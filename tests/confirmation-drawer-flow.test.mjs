import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../popup.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");

assert.match(html, /id="selectionDrawer"/, "应保留独立的已选用户管理抽屉");
assert.match(html, /id="confirmationDrawer"/, "应提供独立的取关确认抽屉");
assert.doesNotMatch(html, /id="confirmDialog"|id="confirmCheckbox"/, "不应恢复旧确认弹窗或勾选框");
assert.match(
  script,
  /elements\.runButton\.addEventListener\("click", openConfirmationDrawer\)/,
  "主操作按钮应先进入确认抽屉"
);
assert.match(
  script,
  /function editFromConfirmationDrawer\(\) \{\s*closeConfirmationDrawer\(\);\s*openSelectionDrawer\(\);\s*\}/,
  "确认抽屉的返回修改操作应进入原管理抽屉"
);
assert.match(
  script,
  /elements\.confirmationDrawerSubmitButton\.addEventListener\("click", \(\) => \{\s*closeConfirmationDrawer\(\);\s*runBatch\(\);\s*\}\)/,
  "只有确认抽屉的最终按钮才能开始批处理"
);
assert.match(
  script,
  /data-confirmation-remove-mid|confirmationRemoveMid/,
  "确认抽屉应支持逐个取消选中"
);

console.log("confirmation drawer flow regression passed");
