"use strict";

const BUY_LEADS_URL = "https://seller.indiamart.com/bltxn/?pref=relevant&l_t_b=1";

const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const clickCount = document.getElementById("clickCount");
const pageStatus = document.getElementById("pageStatus");
const toggleBtn  = document.getElementById("toggleBtn");
const openBtn    = document.getElementById("openBtn");
const resetBtn   = document.getElementById("resetBtn");
const kwInput    = document.getElementById("kwInput");
const kwAdd      = document.getElementById("kwAdd");
const kwTags     = document.getElementById("kwTags");
const kwBadge    = document.getElementById("kwBadge");

let currentKeywords = [];

// ── Render keyword tags ────────────────────────────────────────────
function renderKeywords(keywords) {
  currentKeywords = keywords || [];
  kwTags.innerHTML = "";

  if (currentKeywords.length === 0) {
    kwTags.innerHTML = '<span class="kw-empty">No keywords — clicking all leads</span>';
    kwBadge.textContent = "All leads";
    kwBadge.style.background = "#422006";
    kwBadge.style.color = "#fbbf24";
    return;
  }

  currentKeywords.forEach((kw, i) => {
    const tag = document.createElement("span");
    tag.className = "kw-tag";
    tag.innerHTML = `${kw} <span class="remove" data-i="${i}">×</span>`;
    kwTags.appendChild(tag);
  });

  kwBadge.textContent = `${currentKeywords.length} keyword${currentKeywords.length > 1 ? "s" : ""}`;
  kwBadge.style.background = "#14532d";
  kwBadge.style.color = "#4ade80";
}

// ── Save keywords and push to content scripts ──────────────────────
async function saveKeywords(keywords) {
  await chrome.storage.local.set({ keywords });
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_KEYWORDS", keywords }).catch(() => {});
  }
  renderKeywords(keywords);
}

// ── Add keyword ────────────────────────────────────────────────────
function addKeyword() {
  const val = kwInput.value.trim();
  if (!val) return;
  if (currentKeywords.map(k => k.toLowerCase()).includes(val.toLowerCase())) {
    kwInput.value = "";
    return;
  }
  const updated = [...currentKeywords, val];
  kwInput.value = "";
  saveKeywords(updated);
}

kwAdd.addEventListener("click", addKeyword);
kwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addKeyword(); });

// ── Remove keyword via tag click ───────────────────────────────────
kwTags.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove")) {
    const i = parseInt(e.target.dataset.i);
    const updated = currentKeywords.filter((_, idx) => idx !== i);
    saveKeywords(updated);
  }
});

// ── Render exclude keyword tags ────────────────────────────────────
let currentExcludes = [];

function renderExcludes(excludes) {
  currentExcludes = excludes || [];
  const exTags = document.getElementById("exTags");
  exTags.innerHTML = "";

  if (currentExcludes.length === 0) {
    exTags.innerHTML = '<span class="kw-empty">No exclusions set</span>';
    return;
  }

  currentExcludes.forEach((kw, i) => {
    const tag = document.createElement("span");
    tag.className = "kw-tag exclude";
    tag.innerHTML = `${kw} <span class="remove" data-i="${i}">×</span>`;
    exTags.appendChild(tag);
  });
}

async function saveExcludes(excludes) {
  await chrome.storage.local.set({ excludeKeywords: excludes });
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_EXCLUDE_KEYWORDS", excludeKeywords: excludes }).catch(() => {});
  }
  renderExcludes(excludes);
}

function addExclude() {
  const val = document.getElementById("exInput").value.trim();
  if (!val) return;
  if (currentExcludes.map(k => k.toLowerCase()).includes(val.toLowerCase())) {
    document.getElementById("exInput").value = "";
    return;
  }
  saveExcludes([...currentExcludes, val]);
  document.getElementById("exInput").value = "";
}

document.getElementById("exAdd").addEventListener("click", addExclude);
document.getElementById("exInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addExclude(); });
document.getElementById("exTags").addEventListener("click", (e) => {
  if (e.target.classList.contains("remove")) {
    const i = parseInt(e.target.dataset.i);
    saveExcludes(currentExcludes.filter((_, idx) => idx !== i));
  }
});

// ── Render main status ─────────────────────────────────────────────
function renderStatus(enabled, total, tabUrl, keywords, excludes) {
  statusPill.className = "status-pill " + (enabled ? "on" : "off");
  statusText.textContent = enabled ? "Running" : "Paused";
  clickCount.textContent = total;

  toggleBtn.className = "btn " + (enabled ? "btn-toggle-on" : "btn-toggle-off");
  toggleBtn.textContent = enabled ? "⏸  Pause Bot" : "▶  Resume Bot";

  const onBuyLeads = tabUrl && (tabUrl.includes("bltxn") || tabUrl.includes("buyLead"));
  if (!tabUrl) {
    pageStatus.innerHTML = '<span class="warn">⚠ Not on IndiaMART seller portal</span>';
  } else if (onBuyLeads) {
    pageStatus.innerHTML = '<span class="ok">✓ On Buy Leads page — bot active</span>';
  } else {
    pageStatus.innerHTML = '<span class="warn">⚠ Open Buy Leads page</span> for bot to work';
  }

  renderKeywords(keywords || []);
  renderExcludes(excludes || []);
}

// ── Load state ─────────────────────────────────────────────────────
async function refresh() {
  const data    = await chrome.storage.local.get(["enabled", "totalClicked", "keywords", "excludeKeywords"]);
  const enabled = data.enabled !== false;
  const total   = data.totalClicked || 0;
  const kws     = data.keywords || [];
  const exs     = data.excludeKeywords || [];

  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  if (tabs.length > 0) {
    try {
      const resp = await chrome.tabs.sendMessage(tabs[0].id, { type: "GET_STATUS" });
      renderStatus(resp.enabled, resp.totalClicked, resp.url, resp.keywords, resp.excludeKeywords);
      return;
    } catch { /* content script not ready yet */ }
  }
  renderStatus(enabled, total, tabs[0]?.url || null, kws, exs);
}

// ── Toggle ─────────────────────────────────────────────────────────
toggleBtn.addEventListener("click", async () => {
  const data   = await chrome.storage.local.get("enabled");
  const newVal = data.enabled === false ? true : false; // flip
  await chrome.storage.local.set({ enabled: newVal });
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_ENABLED", value: newVal }).catch(() => {});
  }
  // ── Webhook URL ────────────────────────────────────────────────────
const webhookInput  = document.getElementById("webhookInput");
const webhookSave   = document.getElementById("webhookSave");
const webhookStatus = document.getElementById("webhookStatus");

async function loadWebhook() {
  const data = await chrome.storage.local.get("webhookUrl");
  const url  = data.webhookUrl || "";
  webhookInput.value = url;
  if (url) {
    webhookStatus.textContent = "✓ Sending leads to: " + url;
    webhookStatus.className   = "webhook-status set";
  } else {
    webhookStatus.textContent = "Not configured — leads won't be sent";
    webhookStatus.className   = "webhook-status";
  }
}

webhookSave.addEventListener("click", async () => {
  const url = webhookInput.value.trim();
  await chrome.storage.local.set({ webhookUrl: url });
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_WEBHOOK", webhookUrl: url }).catch(() => {});
  }
  loadWebhook();
});

loadWebhook();
refresh();
});

// ── Open buy leads ─────────────────────────────────────────────────
openBtn.addEventListener("click", () => chrome.tabs.create({ url: BUY_LEADS_URL }));

// ── Reset counter ──────────────────────────────────────────────────
resetBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ totalClicked: 0 });
  chrome.action.setBadgeText({ text: "" });
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "RESET_COUNT" }).catch(() => {});
  }
  // ── Webhook URL ────────────────────────────────────────────────────
const webhookInput  = document.getElementById("webhookInput");
const webhookSave   = document.getElementById("webhookSave");
const webhookStatus = document.getElementById("webhookStatus");

async function loadWebhook() {
  const data = await chrome.storage.local.get("webhookUrl");
  const url  = data.webhookUrl || "";
  webhookInput.value = url;
  if (url) {
    webhookStatus.textContent = "✓ Sending leads to: " + url;
    webhookStatus.className   = "webhook-status set";
  } else {
    webhookStatus.textContent = "Not configured — leads won't be sent";
    webhookStatus.className   = "webhook-status";
  }
}

webhookSave.addEventListener("click", async () => {
  const url = webhookInput.value.trim();
  await chrome.storage.local.set({ webhookUrl: url });
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_WEBHOOK", webhookUrl: url }).catch(() => {});
  }
  loadWebhook();
});

loadWebhook();
refresh();
});

// ── Webhook URL ────────────────────────────────────────────────────
const webhookInput  = document.getElementById("webhookInput");
const webhookSave   = document.getElementById("webhookSave");
const webhookStatus = document.getElementById("webhookStatus");

async function loadWebhook() {
  const data = await chrome.storage.local.get("webhookUrl");
  const url  = data.webhookUrl || "";
  webhookInput.value = url;
  if (url) {
    webhookStatus.textContent = "✓ Sending leads to: " + url;
    webhookStatus.className   = "webhook-status set";
  } else {
    webhookStatus.textContent = "Not configured — leads won't be sent";
    webhookStatus.className   = "webhook-status";
  }
}

webhookSave.addEventListener("click", async () => {
  const url = webhookInput.value.trim();
  await chrome.storage.local.set({ webhookUrl: url });
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_WEBHOOK", webhookUrl: url }).catch(() => {});
  }
  loadWebhook();
});

loadWebhook();
refresh();
