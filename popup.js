const PAGE_SIZE = 5;
let batchPollTimer = null;
let batchCompletionHandled = false;

const state = {
  account: null,
  followings: [],
  categories: [],
  categoryMembers: new Map(),
  selected: new Set(),
  currentPage: 1,
  categoryLoading: false,
  loading: false,
  running: false,
  stopRequested: false
};

const elements = {
  accountText: document.querySelector("#accountText"),
  notice: document.querySelector("#notice"),
  noticeText: document.querySelector("#noticeText"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  categorySelect: document.querySelector("#categorySelect"),
  selectVisibleButton: document.querySelector("#selectVisibleButton"),
  invertVisibleButton: document.querySelector("#invertVisibleButton"),
  clearButton: document.querySelector("#clearButton"),
  loadedCount: document.querySelector("#loadedCount"),
  visibleCount: document.querySelector("#visibleCount"),
  sortSelect: document.querySelector("#sortSelect"),
  selectedCount: document.querySelector("#selectedCount"),
  list: document.querySelector("#list"),
  pagination: document.querySelector("#pagination"),
  previousPageButton: document.querySelector("#previousPageButton"),
  pageInfo: document.querySelector("#pageInfo"),
  nextPageButton: document.querySelector("#nextPageButton"),
  selectAndNextButton: document.querySelector("#selectAndNextButton"),
  emptyState: document.querySelector("#emptyState"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyHint: document.querySelector("#emptyHint"),
  protectSpecial: document.querySelector("#protectSpecial"),
  delaySelect: document.querySelector("#delaySelect"),
  jitterSelect: document.querySelector("#jitterSelect"),
  runButton: document.querySelector("#runButton"),
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmText: document.querySelector("#confirmText"),
  confirmCheckbox: document.querySelector("#confirmCheckbox"),
  confirmButton: document.querySelector("#confirmButton"),
  batchMask: document.querySelector("#batchMask"),
  maskTitle: document.querySelector("#maskTitle"),
  maskProgressText: document.querySelector("#maskProgressText"),
  maskProgressBar: document.querySelector("#maskProgressBar"),
  maskCurrentTarget: document.querySelector("#maskCurrentTarget"),
  maskResultText: document.querySelector("#maskResultText"),
  maskStopButton: document.querySelector("#maskStopButton"),
  maskForceStopButton: document.querySelector("#maskForceStopButton")
};

function sendExtensionMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "扩展后台没有返回结果。"));
        return;
      }
      resolve(response.result);
    });
  });
}

function sendApi(operation, payload = {}) {
  return sendExtensionMessage({ type: "BILI_API", operation, payload });
}

function setNotice(message, tone = "info") {
  elements.notice.className = `notice ${tone}`;
  elements.noticeText.textContent = message;
}

function apiMessage(response, fallback = "B 站接口返回错误") {
  return response?.message || response?.msg || fallback;
}

function normalizeFollowing(raw) {
  return {
    mid: String(raw.mid),
    name: raw.uname || `UID ${raw.mid}`,
    sign: raw.sign || "",
    special: raw.special === true || Number(raw.special) === 1,
    attribute: Number(raw.attribute) || 0,
    followedAt: Number(raw.mtime) || 0
  };
}

function getFilteredFollowings() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase("zh-CN");
  const category = elements.categorySelect.value;
  let source = state.followings;
  if (category === "special") {
    source = source.filter((user) => user.special);
  } else if (category.startsWith("group:")) {
    const memberIds = state.categoryMembers.get(category.slice("group:".length));
    source = memberIds ? source.filter((user) => memberIds.has(user.mid)) : [];
  }
  const filtered = query
    ? source.filter((user) =>
        user.name.toLocaleLowerCase("zh-CN").includes(query) || user.mid.includes(query)
      )
    : [...source];
  const direction = elements.sortSelect.value === "asc" ? 1 : -1;
  return filtered.sort((left, right) => {
    if (!left.followedAt && right.followedAt) return 1;
    if (left.followedAt && !right.followedAt) return -1;
    const byTime = (left.followedAt - right.followedAt) * direction;
    if (byTime !== 0) return byTime;
    return left.mid.localeCompare(right.mid, undefined, { numeric: true });
  });
}

function formatFollowTime(timestamp) {
  if (!timestamp) return "时间未知";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function canSelect(user) {
  return !(elements.protectSpecial.checked && user.special);
}

function enforceProtectedSelectionInvariant() {
  if (!elements.protectSpecial.checked || state.selected.size === 0) return;
  for (const user of state.followings) {
    if (user.special) state.selected.delete(user.mid);
  }
}

function getPageFollowings(filtered = getFilteredFollowings()) {
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.currentPage = Math.min(Math.max(1, state.currentPage), pageCount);
  const start = (state.currentPage - 1) * PAGE_SIZE;
  return filtered.slice(start, start + PAGE_SIZE);
}

function render() {
  enforceProtectedSelectionInvariant();
  const filtered = getFilteredFollowings();
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.currentPage = Math.min(Math.max(1, state.currentPage), pageCount);
  const visible = getPageFollowings(filtered);
  elements.loadedCount.textContent = String(state.followings.length);
  elements.visibleCount.textContent = String(visible.length);
  elements.selectedCount.textContent = String(state.selected.size);
  elements.runButton.textContent = state.selected.size > 0
    ? `取消关注已选 ${state.selected.size} 人`
    : "取消关注已选用户";
  elements.runButton.disabled = state.loading || state.running || state.selected.size === 0;
  elements.refreshButton.disabled = state.loading || state.running;
  elements.selectVisibleButton.disabled = state.loading || state.categoryLoading || state.running || visible.length === 0;
  elements.invertVisibleButton.disabled = state.loading || state.categoryLoading || state.running || visible.length === 0;
  elements.clearButton.disabled = state.running || state.selected.size === 0;
  elements.searchInput.disabled = state.loading || state.running;
  elements.categorySelect.disabled = state.loading || state.categoryLoading || state.running;
  elements.sortSelect.disabled = state.loading || state.running;
  elements.protectSpecial.disabled = state.running;
  elements.delaySelect.disabled = state.running;
  elements.jitterSelect.disabled = state.running;

  elements.list.replaceChildren();
  elements.list.hidden = visible.length === 0;
  elements.emptyState.hidden = visible.length > 0;
  elements.pagination.hidden = filtered.length === 0;
  elements.pageInfo.textContent = `第 ${state.currentPage} / ${pageCount} 页`;
  elements.previousPageButton.disabled = state.loading || state.running || state.currentPage <= 1;
  elements.nextPageButton.disabled = state.loading || state.running || state.currentPage >= pageCount;
  elements.selectAndNextButton.disabled = state.loading || state.categoryLoading || state.running || state.currentPage >= pageCount;

  if (visible.length === 0) {
    if (state.categoryLoading) {
      elements.emptyTitle.textContent = "正在读取关注分类";
      elements.emptyHint.textContent = "请稍候";
    } else if (state.loading) {
      elements.emptyTitle.textContent = "正在载入关注列表";
      elements.emptyHint.textContent = "关注较多时需要一些时间";
    } else if (state.followings.length > 0) {
      elements.emptyTitle.textContent = "没有匹配的用户";
      elements.emptyHint.textContent = "换一个昵称或 UID 试试";
    } else {
      elements.emptyTitle.textContent = "关注列表为空";
      elements.emptyHint.textContent = "或暂时无法读取列表";
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const user of visible) {
    const row = document.createElement("label");
    row.className = `follow-item${user.special && elements.protectSpecial.checked ? " protected" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(user.mid);
    checkbox.disabled = state.running || !canSelect(user);
    checkbox.dataset.mid = user.mid;

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = Array.from(user.name.trim())[0]?.toUpperCase() || "B";

    const copy = document.createElement("span");
    copy.className = "user-copy";
    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = user.name;
    name.title = user.name;
    const meta = document.createElement("div");
    meta.className = "user-meta";
    meta.textContent = `UID ${user.mid} · 关注于 ${formatFollowTime(user.followedAt)}`;
    meta.title = user.sign ? `${meta.textContent} · ${user.sign}` : meta.textContent;
    copy.append(name, meta);

    row.append(checkbox, avatar, copy);
    if (user.special) {
      const badge = document.createElement("span");
      badge.className = "special-badge";
      badge.textContent = "特别关注";
      row.append(badge);
    }
    fragment.append(row);
  }
  elements.list.append(fragment);
}

function renderCategoryOptions() {
  const previousValue = elements.categorySelect.value;
  const options = [
    { value: "all", label: "全部关注" },
    { value: "special", label: `特别关注（${state.followings.filter((user) => user.special).length}）` },
    ...state.categories.map((category) => ({
      value: `group:${category.id}`,
      label: Number.isFinite(category.count) ? `${category.name}（${category.count}）` : category.name
    }))
  ];

  elements.categorySelect.replaceChildren();
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    elements.categorySelect.append(option);
  }
  elements.categorySelect.value = options.some((item) => item.value === previousValue) ? previousValue : "all";
}

async function loadCategoryDefinitions() {
  const response = await sendApi("tags");
  if (response.code !== 0) throw new Error(apiMessage(response, "读取关注分类失败"));
  const rawCategories = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.data?.list) ? response.data.list : [];
  const byId = new Map();
  byId.set("0", { id: "0", name: "默认分组", count: NaN });
  for (const raw of rawCategories) {
    const id = String(raw.tagid ?? raw.id ?? "");
    if (!/^-?\d+$/.test(id)) continue;
    const name = raw.name || `分类 ${id}`;
    if (id === "-10" || name.includes("特别关注")) continue;
    byId.set(id, {
      id,
      name,
      count: Number(raw.count)
    });
  }
  state.categories = [...byId.values()];
  renderCategoryOptions();
}

async function loadCategoryMembers(categoryId) {
  if (state.categoryMembers.has(categoryId)) return;
  state.categoryLoading = true;
  setNotice("正在读取所选关注分类…");
  render();

  try {
    const memberIds = new Set();
    const pageSize = 50;
    let page = 1;
    while (page <= 200) {
      const response = await sendApi("tagMembers", { tagId: categoryId, page, pageSize });
      if (response.code !== 0) throw new Error(apiMessage(response, "读取分类成员失败"));
      const list = Array.isArray(response.data?.list)
        ? response.data.list
        : Array.isArray(response.data) ? response.data : [];
      const previousSize = memberIds.size;
      for (const raw of list) {
        const mid = String(raw.mid ?? raw.uid ?? "");
        if (/^\d+$/.test(mid)) memberIds.add(mid);
      }
      if (list.length < pageSize || list.length === 0) break;
      if (memberIds.size === previousSize) {
        throw new Error(`分类接口第 ${page} 页未返回新成员，已停止以避免重复请求。`);
      }
      setNotice(`正在读取所选关注分类：已载入 ${memberIds.size} 人…`);
      page += 1;
    }
    state.categoryMembers.set(categoryId, memberIds);
    setNotice(`分类读取完成，共匹配 ${memberIds.size} 个账号`, "success");
  } catch (error) {
    elements.categorySelect.value = "all";
    setNotice(`关注分类暂不可用：${error.message || String(error)}`, "warning");
  } finally {
    state.categoryLoading = false;
    state.currentPage = 1;
    render();
  }
}

async function loadFollowings() {
  if (state.running) return;
  state.loading = true;
  state.followings = [];
  state.categories = [];
  state.categoryMembers.clear();
  state.selected.clear();
  state.currentPage = 1;
  elements.searchInput.value = "";
  elements.categorySelect.value = "all";
  setNotice("正在检查登录状态");
  render();

  try {
    const nav = await sendApi("nav");
    if (nav.code !== 0 || !nav.data?.isLogin) {
      throw new Error("当前 B 站页面未登录，请登录后刷新页面再试。");
    }

    state.account = { mid: String(nav.data.mid), name: nav.data.uname || "已登录用户" };
    elements.accountText.textContent = `${state.account.name} · UID ${state.account.mid}`;

    const pageSize = 50;
    const loadConcurrency = 3;
    const seen = new Set();
    let categoryError = null;
    const categoryPromise = loadCategoryDefinitions().catch((error) => { categoryError = error; });
    const mergeUsers = (list) => {
      for (const raw of list) {
        const user = normalizeFollowing(raw);
        if (!seen.has(user.mid)) {
          seen.add(user.mid);
          state.followings.push(user);
        }
      }
    };

    setNotice("正在读取第 1 页关注…");
    const firstResponse = await sendApi("followings", { vmid: state.account.mid, page: 1, pageSize });
    if (firstResponse.code !== 0) throw new Error(apiMessage(firstResponse, "读取第 1 页失败"));
    const firstList = Array.isArray(firstResponse.data?.list) ? firstResponse.data.list : [];
    mergeUsers(firstList);
    render();

    const total = Number(firstResponse.data?.total);
    if (Number.isFinite(total)) {
      const totalPages = Math.min(200, Math.max(1, Math.ceil(total / pageSize)));
      const pendingPages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2);
      let cursor = 0;
      let completedPages = 1;
      const worker = async () => {
        while (cursor < pendingPages.length) {
          const page = pendingPages[cursor];
          cursor += 1;
          const response = await sendApi("followings", { vmid: state.account.mid, page, pageSize });
          if (response.code !== 0) throw new Error(apiMessage(response, `读取第 ${page} 页失败`));
          mergeUsers(Array.isArray(response.data?.list) ? response.data.list : []);
          completedPages += 1;
          setNotice(`正在并行读取关注：${completedPages} / ${totalPages} 页，已载入 ${state.followings.length} 人…`);
          render();
        }
      };
      await Promise.all(Array.from({ length: Math.min(loadConcurrency, pendingPages.length) }, worker));
    } else {
      let page = 2;
      let previousList = firstList;
      while (previousList.length === pageSize && page <= 200) {
        setNotice(`正在读取第 ${page} 页，已载入 ${state.followings.length} 人…`);
        const response = await sendApi("followings", { vmid: state.account.mid, page, pageSize });
        if (response.code !== 0) throw new Error(apiMessage(response, `读取第 ${page} 页失败`));
        previousList = Array.isArray(response.data?.list) ? response.data.list : [];
        mergeUsers(previousList);
        render();
        page += 1;
      }
    }

    await categoryPromise;
    renderCategoryOptions();
    if (!categoryError) {
      setNotice(`读取完成，共载入 ${state.followings.length} 个关注及 ${state.categories.length} 个分类`, "success");
    } else {
      state.categories = [];
      renderCategoryOptions();
      setNotice(`关注已读取；分类暂不可用：${categoryError.message || String(categoryError)}`, "warning");
    }
  } catch (error) {
    setNotice(error.message || String(error), "error");
    elements.accountText.textContent = "请在已登录的 B 站网页中使用";
  } finally {
    state.loading = false;
    render();
  }
}

function reconcileProtectedSelections() {
  enforceProtectedSelectionInvariant();
  render();
}

function selectVisible() {
  for (const user of getPageFollowings()) {
    if (canSelect(user)) state.selected.add(user.mid);
  }
  render();
}

function selectNextPageAndSelect() {
  const filtered = getFilteredFollowings();
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (state.currentPage >= pageCount) return;
  state.currentPage += 1;
  for (const user of getPageFollowings(filtered)) {
    if (canSelect(user)) state.selected.add(user.mid);
  }
  render();
}

function invertVisible() {
  for (const user of getPageFollowings()) {
    if (!canSelect(user)) continue;
    if (state.selected.has(user.mid)) state.selected.delete(user.mid);
    else state.selected.add(user.mid);
  }
  render();
}

function openConfirmation() {
  enforceProtectedSelectionInvariant();
  if (state.selected.size === 0 || state.running) return;
  const selectedUsers = state.followings.filter((user) => state.selected.has(user.mid));
  const preview = selectedUsers.slice(0, 3).map((user) => user.name).join("、");
  const remainder = selectedUsers.length > 3 ? ` 等 ${selectedUsers.length} 人` : "";
  elements.confirmText.textContent = `即将串行取消关注：${preview}${remainder}。间隔采用 σ ${elements.jitterSelect.value}% 的高斯波动，执行后这些用户会从当前列表移除。`;
  elements.confirmCheckbox.checked = false;
  elements.confirmButton.disabled = true;
  elements.confirmDialog.showModal();
}

function updateBatchMask(status) {
  elements.batchMask.hidden = false;
  elements.maskTitle.textContent = status.running ? "取关ing🍵" : status.status === "completed" ? "取关完成🍵" : "任务已停止";
  elements.maskProgressText.textContent = `${status.processed || 0} / ${status.total || 0}`;
  const percentage = status.total ? Math.round((status.processed / status.total) * 100) : 0;
  elements.maskProgressBar.style.width = `${percentage}%`;
  elements.maskCurrentTarget.textContent = status.currentTarget || status.message || "正在准备后台任务…";
  elements.maskResultText.textContent = `成功 ${status.successCount || 0} · 失败 ${status.failureCount || 0}`;
  elements.maskStopButton.hidden = !status.running;
  elements.maskForceStopButton.hidden = !status.running;
  elements.maskStopButton.disabled = Boolean(status.stopRequested);
  elements.maskForceStopButton.disabled = Boolean(status.forceRequested);
  elements.maskStopButton.textContent = status.stopRequested ? "正在停止…" : "停止后续操作";
  elements.maskForceStopButton.textContent = status.forceRequested ? "正在中断…" : "强制中断";
}

async function pollBatchStatus() {
  try {
    const status = await sendExtensionMessage({ type: "BATCH_STATUS" });
    updateBatchMask(status);
    state.running = Boolean(status.running);
    render();
    if (status.running) {
      batchPollTimer = setTimeout(pollBatchStatus, 250);
      return;
    }
    if (!batchCompletionHandled) {
      batchCompletionHandled = true;
      setTimeout(() => finishBatchInPopup(status), 900);
    }
  } catch (error) {
    elements.maskCurrentTarget.textContent = `无法读取后台进度：${error.message || String(error)}`;
    batchPollTimer = setTimeout(pollBatchStatus, 1000);
  }
}

async function finishBatchInPopup(status) {
  if (batchPollTimer) clearTimeout(batchPollTimer);
  elements.batchMask.hidden = true;
  state.running = false;
  await loadFollowings();
  showBatchCompletionNotice(status);
  sendExtensionMessage({ type: "BATCH_ACK" }).catch(() => {});
}

function showBatchCompletionNotice(status) {
  if (status.status === "completed" && status.failureCount === 0) {
    setNotice(`处理完成，已取消关注 ${status.successCount} 人。`, "success");
  } else if (status.status === "completed") {
    setNotice(`处理完成：成功 ${status.successCount} 人，失败 ${status.failureCount} 人。`, "warning");
  } else {
    setNotice(`${status.message || "任务已停止"}：成功 ${status.successCount} 人，失败 ${status.failureCount} 人。`, "warning");
  }
}

async function runBatch() {
  if (state.running || state.selected.size === 0) return;
  const queue = state.followings
    .filter((user) => state.selected.has(user.mid) && canSelect(user))
    .map((user) => ({ mid: user.mid, name: user.name }));
  if (queue.length === 0) {
    setNotice("所选用户均受“特别关注”保护。", "warning");
    return;
  }

  state.running = true;
  batchCompletionHandled = false;
  render();
  updateBatchMask({ running: true, status: "running", processed: 0, total: queue.length, successCount: 0, failureCount: 0 });
  try {
    const status = await sendExtensionMessage({
      type: "BATCH_START",
      queue,
      meanDelay: Number(elements.delaySelect.value) || 1800,
      jitterPercent: Number(elements.jitterSelect.value) || 10
    });
    updateBatchMask(status);
    pollBatchStatus();
  } catch (error) {
    state.running = false;
    elements.batchMask.hidden = true;
    setNotice(error.message || String(error), "error");
    render();
  }
}

async function stopBackgroundBatch() {
  elements.maskStopButton.disabled = true;
  elements.maskStopButton.textContent = "正在停止…";
  try {
    const status = await sendExtensionMessage({ type: "BATCH_STOP" });
    updateBatchMask(status);
  } catch (error) {
    elements.maskCurrentTarget.textContent = error.message || String(error);
  }
}

async function forceStopBackgroundBatch() {
  elements.maskStopButton.disabled = true;
  elements.maskForceStopButton.disabled = true;
  elements.maskForceStopButton.textContent = "正在中断…";
  elements.maskCurrentTarget.textContent = "正在强制中断当前请求…";
  try {
    const status = await sendExtensionMessage({ type: "BATCH_FORCE_STOP" });
    updateBatchMask(status);
  } catch (error) {
    elements.maskCurrentTarget.textContent = error.message || String(error);
  }
}

elements.list.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type='checkbox'][data-mid]");
  if (!checkbox) return;
  const user = state.followings.find((item) => item.mid === checkbox.dataset.mid);
  if (checkbox.checked && user && canSelect(user)) state.selected.add(checkbox.dataset.mid);
  else state.selected.delete(checkbox.dataset.mid);
  render();
});

elements.searchInput.addEventListener("input", () => { state.currentPage = 1; render(); });
elements.sortSelect.addEventListener("change", () => { state.currentPage = 1; render(); });
elements.categorySelect.addEventListener("change", async () => {
  state.currentPage = 1;
  const value = elements.categorySelect.value;
  if (value.startsWith("group:")) {
    await loadCategoryMembers(value.slice("group:".length));
  } else {
    render();
  }
});
elements.refreshButton.addEventListener("click", loadFollowings);
elements.selectAndNextButton.addEventListener("click", selectNextPageAndSelect);
elements.selectVisibleButton.addEventListener("click", selectVisible);
elements.invertVisibleButton.addEventListener("click", invertVisible);
elements.clearButton.addEventListener("click", () => { state.selected.clear(); render(); });
elements.previousPageButton.addEventListener("click", () => {
  state.currentPage = Math.max(1, state.currentPage - 1);
  render();
});
elements.nextPageButton.addEventListener("click", () => {
  state.currentPage += 1;
  render();
});
elements.protectSpecial.addEventListener("change", reconcileProtectedSelections);
elements.runButton.addEventListener("click", openConfirmation);
elements.maskStopButton.addEventListener("click", stopBackgroundBatch);
elements.maskForceStopButton.addEventListener("click", forceStopBackgroundBatch);
elements.confirmCheckbox.addEventListener("change", () => {
  elements.confirmButton.disabled = !elements.confirmCheckbox.checked;
});
elements.confirmDialog.addEventListener("close", () => {
  if (elements.confirmDialog.returnValue === "confirm" && elements.confirmCheckbox.checked) {
    runBatch();
  }
});

async function initialize() {
  let previousStatus = null;
  try {
    const status = await sendExtensionMessage({ type: "BATCH_STATUS" });
    if (status.running) {
      state.running = true;
      batchCompletionHandled = false;
      render();
      updateBatchMask(status);
      pollBatchStatus();
      return;
    }
    previousStatus = status;
  } catch {
    // 正常加载流程会给出更具体的页面连接错误。
  }
  await loadFollowings();
  if (previousStatus && previousStatus.status !== "idle" && previousStatus.finishedAt) {
    showBatchCompletionNotice(previousStatus);
    sendExtensionMessage({ type: "BATCH_ACK" }).catch(() => {});
  }
}

initialize();
