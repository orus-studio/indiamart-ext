/**
 * Background service worker
 * - Updates the extension badge with click count
 * - Sets a periodic alarm to reload the buy-leads tab so fresh leads appear
 */

const BUY_LEADS_URL   = "https://seller.indiamart.com/bltxn/";
const RELOAD_INTERVAL = 1; // minutes between tab reloads (Chrome alarms minimum = 1)

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

  // POST to webhook — done here to avoid IndiaMART's CSP restrictions
  if (msg.type === "POST_WEBHOOK") {
    fetch(msg.url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(msg.payload),
    })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      console.log(`[Webhook] ✅ ${res.status} — ${JSON.stringify(body)}`);
      sendResponse({ ok: res.ok, status: res.status, body });
    })
    .catch((err) => {
      console.error(`[Webhook] ❌ fetch failed: ${err.message}`);
      sendResponse({ ok: false, error: err.message });
    });

    return true; // keep message channel open for async response
  }
});

// ── Periodic alarm to reload the buy-leads tab ────────────────────
chrome.alarms.create("reloadLeads", { periodInMinutes: RELOAD_INTERVAL });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "reloadLeads") return;

  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled === false) return;

  // Find any open IndiaMART seller tab
  const tabs = await chrome.tabs.query({ url: "https://seller.indiamart.com/*" });

  if (tabs.length === 0) {
    // No tab open — open one
    chrome.tabs.create({ url: BUY_LEADS_URL, active: false });
  } else {
    // Reload the first matching tab
    for (const tab of tabs) {
      if (tab.url.includes("bltxn") || tab.url.includes("buyLead")) {
        chrome.tabs.reload(tab.id);
        return;
      }
    }
    // No buy-leads tab found — reload whatever seller tab is open
    chrome.tabs.reload(tabs[0].id);
  }
});

// ── On install: open the buy-leads page automatically ─────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: true, totalClicked: 0 });
  chrome.tabs.create({ url: BUY_LEADS_URL });
});