import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const popupSource = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const match = popupSource.match(
  /function openConfirmationDrawer\(\) \{[\s\S]*?\n\}\n\nfunction closeConfirmationDrawer/
);

assert.ok(match, "无法从 popup.js 提取 openConfirmationDrawer");

let closeSelectionCount = 0;
const context = vm.createContext({
  state: { selected: new Set(["10001"]), running: false },
  elements: {
    selectionDrawer: { hidden: false },
    confirmationDrawer: { hidden: true },
    confirmationDrawerCloseButton: { focus: () => {} }
  },
  enforceProtectedSelectionInvariant: () => {},
  closeSelectionDrawer: () => {
    closeSelectionCount += 1;
    context.elements.selectionDrawer.hidden = true;
  },
  renderConfirmationDrawer: () => {},
  Set
});

vm.runInContext(
  `${match[0].replace(/\n\nfunction closeConfirmationDrawer$/, "")}\nthis.openConfirmationDrawer = openConfirmationDrawer;`,
  context
);

context.openConfirmationDrawer();

assert.equal(closeSelectionCount, 1, "打开确认抽屉前必须主动关闭管理抽屉");
assert.equal(context.elements.selectionDrawer.hidden, true, "管理抽屉必须保持关闭");
assert.equal(context.elements.confirmationDrawer.hidden, false, "确认抽屉必须打开");

console.log("drawer exclusivity regression passed");
