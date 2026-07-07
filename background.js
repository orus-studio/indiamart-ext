/**
 * Background service worker
 * - Updates the extension badge with click count
 * - Sets a periodic alarm to reload the buy-leads tab so fresh leads appear
 */

const BUY_LEADS_URL    = "https://seller.indiamart.com/bltxn/";
const RELOAD_MIN_MIN   = 1; // minimum minutes between tab reloads
const RELOAD_MAX_MIN   = 5; // maximum minutes between tab reloads

function randomReloadDelayMinutes() {
  return RELOAD_MIN_MIN + Math.random() * (RELOAD_MAX_MIN - RELOAD_MIN_MIN);
}

// Schedules the next reload at a random point 1-5 minutes from now.
// (Chrome alarms only support one-shot "delayInMinutes" precisely, so we
// re-create the alarm each time it fires rather than using a fixed period.)
function scheduleNextReload() {
  const delay = randomReloadDelayMinutes();
  chrome.alarms.create("reloadLeads", { delayInMinutes: delay });
  console.log(`[IndiaMART Bot] ⏱ Next tab reload scheduled in ${delay.toFixed(1)} min`);
}

// ── Badge helper ───────────────────────────────────────────────────
function setBadge(count) {
  const text = count > 0 ? (count > 999 ? "999+" : String(count)) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" }); // green
}

// ── Restore badge on startup ───────────────────────────────────────
chrome.storage.local.get(["totalClicked"], (data) => {
  setBadge(data.totalClicked || 0);
});

// ── Handle messages from content script ───────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CLICKED") {
    setBadge(msg.totalClicked);
  }
});

// ── Randomized alarm to reload the buy-leads tab (1-5 min) ─────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "reloadLeads") return;

  // Always schedule the next one first, so a failure below can't kill the loop.
  scheduleNextReload();

  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled === false) {
    console.log("[IndiaMART Bot] ⏸ Bot disabled — skipping scheduled reload");
    return;
  }

  // Find any open IndiaMART seller tab
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });

  if (tabs.length === 0) {
    // No tab open — open one
    console.log("[IndiaMART Bot] 🆕 No seller tab open — opening buy-leads page");
    chrome.tabs.create({ url: BUY_LEADS_URL, active: false });
    return;
  }

  // Reload the first matching buy-leads tab
  for (const tab of tabs) {
    if (tab.url.includes("bltxn") || tab.url.includes("buyLead")) {
      console.log(`[IndiaMART Bot] 🔄 Reloading buy-leads tab ${tab.id}`);
      chrome.tabs.reload(tab.id);
      return;
    }
  }
  // No buy-leads tab found — reload whatever seller tab is open
  console.log(`[IndiaMART Bot] 🔄 No buy-leads tab found — reloading seller tab ${tabs[0].id}`);
  chrome.tabs.reload(tabs[0].id);
});

// ── On install: open the buy-leads page automatically ─────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: true, totalClicked: 0 });
  chrome.tabs.create({ url: BUY_LEADS_URL });
  scheduleNextReload();
});

// ── On browser/service-worker restart: make sure the loop is alive ──
chrome.runtime.onStartup.addListener(() => {
  scheduleNextReload();
});

// Also self-heal in case the alarm was somehow cleared without a matching
// onInstalled/onStartup event (e.g. service worker woke up for another reason).
chrome.alarms.get("reloadLeads", (alarm) => {
  if (!alarm) scheduleNextReload();
});