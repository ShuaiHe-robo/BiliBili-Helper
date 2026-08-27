const BILIBILI_PAGE_PATTERN = /^https:\/\/([a-z0-9-]+\.)*bilibili\.com\//i;
const ALLOWED_OPERATIONS = new Set(["nav", "followings", "tags", "tagMembers", "unfollow"]);

let batchState = createIdleBatchState();
let batchTabId = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "BILI_API" && ALLOWED_OPERATIONS.has(message.operation)) {
    runInActiveBilibiliTab(message.operation, message.payload || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "BATCH_START") {
    startBatch(message.queue, message.meanDelay, message.jitterPercent)
      .then(() => sendResponse({ ok: true, result: snapshotBatchState() }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "BATCH_STATUS") {
    sendResponse({ ok: true, result: snapshotBatchState() });
    return false;
  }
  if (message?.type === "BATCH_STOP") {
    if (batchState.running) batchState.stopRequested = true;
    sendResponse({ ok: true, result: snapshotBatchState() });
    return false;
  }
  if (message?.type === "BATCH_FORCE_STOP") {
    forceStopBatch()
      .then(() => sendResponse({ ok: true, result: snapshotBatchState() }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "BATCH_ACK") {
    if (!batchState.running) batchState = createIdleBatchState();
    sendResponse({ ok: true, result: snapshotBatchState() });
    return false;
  }
  return false;
});

function createIdleBatchState() {
  return {
    status: "idle",
    running: false,
    stopRequested: false,
    forceRequested: false,
    total: 0,
    processed: 0,
    successCount: 0,
    failureCount: 0,
    currentTarget: "",
    waitMs: 0,
    failed: [],
    message: "",
    startedAt: 0,
    finishedAt: 0
  };
}

function snapshotBatchState() {
  return JSON.parse(JSON.stringify(batchState));
}

async function getActiveBilibiliTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !BILIBILI_PAGE_PATTERN.test(tab.url || "")) {
    throw new Error("请先打开一个哔哩哔哩网页，并保持该标签页处于当前窗口。");
  }
  return tab;
}

async function runInActiveBilibiliTab(operation, payload) {
  const tab = await getActiveBilibiliTab();
  batchTabId = tab.id;
  return runInBilibiliTab(tab.id, operation, payload);
}

async function runInBilibiliTab(tabId, operation, payload) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("批处理绑定的 B 站标签页已关闭。");
  }
  if (!BILIBILI_PAGE_PATTERN.test(tab.url || "")) {
    throw new Error("批处理绑定的 B 站标签页已关闭或离开 B 站。");
  }
  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: requestBilibiliApi,
      args: [operation, payload]
    });
  } catch (error) {
    if (/No tab|No frame|closed|Invalid tab/i.test(error.message || "")) {
      throw new Error("批处理绑定的 B 站标签页已关闭。");
    }
    throw error;
  }
  const first = injection?.[0];
  if (!first || first.result === undefined) {
    throw new Error("无法连接 B 站页面，请保持开始操作时的标签页打开。");
  }
  if (first.result?.__extensionError) throw new Error(first.result.__extensionError);
  return first.result;
}

async function startBatch(rawQueue, rawMeanDelay, rawJitterPercent) {
  if (batchState.running) throw new Error("已有取关任务正在运行。");
  const source = Array.isArray(rawQueue) ? rawQueue : [];
  const seen = new Set();
  const queue = [];
  for (const raw of source) {
    const mid = String(raw?.mid || "");
    if (!/^\d+$/.test(mid) || seen.has(mid)) continue;
    seen.add(mid);
    queue.push({ mid, name: String(raw?.name || `UID ${mid}`).slice(0, 100) });
  }
  if (queue.length === 0) throw new Error("没有可执行的已选账号。");
  if (queue.length > 10000) throw new Error("单次任务数量过多，请分批执行。");

  const meanDelay = Math.min(10000, Math.max(1200, Number(rawMeanDelay) || 1800));
  const parsedJitter = Number(rawJitterPercent);
  const jitterPercent = Math.min(50, Math.max(5, Number.isFinite(parsedJitter) ? parsedJitter : 10));
  const tab = await getActiveBilibiliTab();
  batchState = {
    ...createIdleBatchState(),
    status: "running",
    running: true,
    total: queue.length,
    message: "取关ing🍵",
    startedAt: Date.now()
  };
  void processBatch(tab.id, queue, meanDelay, jitterPercent).catch((error) => {
    batchState.running = false;
    batchState.status = "failed";
    batchState.message = error.message || String(error);
    batchState.finishedAt = Date.now();
    batchTabId = null;
  });
}

async function forceStopBatch() {
  if (!batchState.running) return;
  batchState.stopRequested = true;
  batchState.forceRequested = true;
  batchState.message = "已请求强制中断当前操作";
  batchState.currentTarget = "正在强制中断当前网络请求…";
  const tabId = batchTabId;
  if (tabId === null) return;
  try {
    await runInBilibiliTab(tabId, "abortUnfollow", {});
  } catch (error) {
    batchState.currentTarget = `中断信号已发送：${error.message || String(error)}`;
  }
}

async function processBatch(tabId, queue, meanDelay, jitterPercent) {
  for (let index = 0; index < queue.length; index += 1) {
    if (batchState.stopRequested) break;
    const user = queue[index];
    batchState.currentTarget = `当前：${user.name}（UID ${user.mid}）`;
    batchState.waitMs = 0;
    try {
      const response = await runInBilibiliTab(tabId, "unfollow", { fid: user.mid });
      if (response.code !== 0) throw new Error(`${apiMessage(response)}（${response.code}）`);
      batchState.successCount += 1;
    } catch (error) {
      batchState.failureCount += 1;
      batchState.failed.push(`${user.name}：${error.message || String(error)}`);
      const message = error.message || "";
      if (/请求被拦截|-412|频繁|风控|登录凭证|标签页已关闭|离开 B 站/.test(message)) {
        batchState.stopRequested = true;
        batchState.message = /标签页/.test(message)
          ? message
          : "检测到可能的频率限制，已自动停止后续操作。";
      }
    }
    batchState.processed = index + 1;
    if (!batchState.stopRequested && index < queue.length - 1) {
      const waitMilliseconds = randomizedDelay(meanDelay, jitterPercent);
      batchState.waitMs = waitMilliseconds;
      batchState.currentTarget = `随机等待 ${(waitMilliseconds / 1000).toFixed(2)} 秒后继续…`;
      await sleepWithStop(waitMilliseconds);
    }
  }

  batchState.running = false;
  batchTabId = null;
  batchState.waitMs = 0;
  batchState.finishedAt = Date.now();
  if (batchState.stopRequested) {
    batchState.status = "stopped";
    if (!batchState.message || batchState.message === "取关ing🍵") batchState.message = "批处理已停止";
  } else {
    batchState.status = "completed";
    batchState.message = batchState.failureCount > 0 ? "批处理完成，部分账号失败" : "批处理已完成";
  }
}

function apiMessage(response, fallback = "B 站接口返回错误") {
  return response?.message || response?.msg || fallback;
}

function secureUnitRandom() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] + 1) / 4294967297;
}

function gaussianRandom() {
  const first = secureUnitRandom();
  const second = secureUnitRandom();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function randomizedDelay(meanMilliseconds, jitterPercent) {
  const standardDeviation = meanMilliseconds * (jitterPercent / 100);
  const sampled = meanMilliseconds + gaussianRandom() * standardDeviation;
  const lowerBound = Math.max(1000, meanMilliseconds * 0.5);
  const upperBound = meanMilliseconds * 1.5;
  return Math.round(Math.min(upperBound, Math.max(lowerBound, sampled)));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sleepWithStop(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!batchState.stopRequested && Date.now() < deadline) {
    await sleep(Math.min(200, deadline - Date.now()));
  }
}

async function requestBilibiliApi(operation, payload) {
  try {
    const requestJson = async (url, options = {}) => {
      const response = await fetch(url, { credentials: "include", cache: "no-store", ...options });
      if (!response.ok) throw new Error(`网络请求失败（HTTP ${response.status}）`);
      const json = await response.json();
      if (typeof json?.code !== "number") throw new Error("B 站返回了无法识别的数据。");
      return json;
    };
    if (operation === "abortUnfollow") {
      const controller = window.__biliBatchUnfollowController;
      if (controller) controller.abort();
      return { code: 0, message: controller ? "中断信号已发送" : "当前没有进行中的请求" };
    }
    if (operation === "nav") return await requestJson("https://api.bilibili.com/x/web-interface/nav");
    if (operation === "followings") {
      const vmid = String(payload.vmid || "");
      const page = Math.max(1, Number(payload.page) || 1);
      const pageSize = Math.min(50, Math.max(1, Number(payload.pageSize) || 50));
      if (!/^\d+$/.test(vmid)) throw new Error("无效的用户 UID。");
      const url = new URL("https://api.bilibili.com/x/relation/followings");
      url.searchParams.set("vmid", vmid);
      url.searchParams.set("pn", String(page));
      url.searchParams.set("ps", String(pageSize));
      url.searchParams.set("order", "desc");
      url.searchParams.set("jsonp", "jsonp");
      return await requestJson(url.toString());
    }
    if (operation === "tags") return await requestJson("https://api.bilibili.com/x/relation/tags");
    if (operation === "tagMembers") {
      const tagId = String(payload.tagId ?? "");
      const page = Math.max(1, Number(payload.page) || 1);
      const pageSize = Math.min(50, Math.max(1, Number(payload.pageSize) || 50));
      if (!/^-?\d+$/.test(tagId)) throw new Error("无效的关注分类 ID。");
      const url = new URL("https://api.bilibili.com/x/relation/tag");
      url.searchParams.set("tagid", tagId);
      url.searchParams.set("pn", String(page));
      url.searchParams.set("ps", String(pageSize));
      return await requestJson(url.toString());
    }
    if (operation === "unfollow") {
      const fid = String(payload.fid || "");
      if (!/^\d+$/.test(fid)) throw new Error("无效的目标 UID。");
      const csrf = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("bili_jct="))
        ?.slice("bili_jct=".length);
      if (!csrf) throw new Error("未找到登录凭证，请确认已登录 B 站并刷新页面。");
      const body = new URLSearchParams({ fid, act: "2", re_src: "11", csrf });
      const controller = new AbortController();
      window.__biliBatchUnfollowController = controller;
      try {
        return await requestJson("https://api.bilibili.com/x/relation/modify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: body.toString(),
          signal: controller.signal
        });
      } finally {
        if (window.__biliBatchUnfollowController === controller) {
          delete window.__biliBatchUnfollowController;
        }
      }
    }
    throw new Error("不支持的操作。");
  } catch (error) {
    return { __extensionError: error?.message || String(error) };
  }
}
