/**
 * IndiaMART Lead Auto-Contacter — Content Script
 * Features:
 *  - Keyword filtering: only click leads whose card text matches your keywords
 *  - Anti-idle: simulates mouse movement so IndiaMART doesn't mark you inactive
 */

const CLICK_DELAY_MS = 1500;
const SCAN_INTERVAL  = 15000;

let enabled         = true;
let keywords        = [];   // include keywords (OR logic)
let excludeKeywords = [];   // block keywords — if any match, skip the lead
let webhookUrl      = "";   // your backend POST endpoint
let clickedIds      = new Set();
let totalClicked = 0;
let scanTimer    = null;
let idleTimer    = null;

// ── Load persisted state ───────────────────────────────────────────
chrome.storage.local.get(["enabled", "totalClicked", "keywords", "excludeKeywords", "webhookUrl"], (data) => {
  enabled         = data.enabled !== false;
  totalClicked    = data.totalClicked || 0;
  keywords        = data.keywords || [];
  excludeKeywords = data.excludeKeywords || [];
  webhookUrl      = data.webhookUrl || "";
  if (enabled) {
    startWatching();
    startAntiIdle();
  }
});

// ── Messages from popup ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    sendResponse({ enabled, totalClicked, url: location.href, keywords, excludeKeywords, webhookUrl });
  }

  if (msg.type === "SET_ENABLED") {
    enabled = msg.value;
    chrome.storage.local.set({ enabled });
    if (enabled) { startWatching(); startAntiIdle(); }
    else          { stopWatching();  stopAntiIdle();  }
    sendResponse({ ok: true });
  }

  if (msg.type === "SET_KEYWORDS") {
    keywords = msg.keywords;
    chrome.storage.local.set({ keywords });
    sendResponse({ ok: true });
  }

  if (msg.type === "SET_EXCLUDE_KEYWORDS") {
    excludeKeywords = msg.excludeKeywords;
    chrome.storage.local.set({ excludeKeywords });
    sendResponse({ ok: true });
  }

  if (msg.type === "SET_WEBHOOK") {
    webhookUrl = msg.webhookUrl;
    chrome.storage.local.set({ webhookUrl });
    sendResponse({ ok: true });
  }

  if (msg.type === "RESET_COUNT") {
    totalClicked = 0;
    chrome.storage.local.set({ totalClicked: 0 });
    sendResponse({ ok: true });
  }

  return true;
});

// ─────────────────────────────────────────────────────────────────
// KEYWORD MATCHING
// ─────────────────────────────────────────────────────────────────

// Get the full visible text of the lead card containing a button
function getCardText(btn) {
  // Walk up to find IndiaMART's card container (uses classes like lstNw, BUY_pr, f1)
  let card = btn;
  for (let i = 0; i < 10; i++) {
    card = card.parentElement;
    if (!card) break;
    const cls = card.className || "";
    if (cls.includes("lstNw") || cls.includes("BUY_") || cls.includes("f1 ")) break;
  }
  if (!card) return "";

  const parts = [];

  // 1. <h2> — the visible requirement title e.g. "Hospital Management System"
  const h2 = card.querySelector("h2");
  if (h2) parts.push(h2.innerText.trim());

  // 2. ofrtitle hidden input — exact requirement name stored by IndiaMART
  const ofrtitle = card.querySelector('input[name="ofrtitle"]');
  if (ofrtitle) parts.push(ofrtitle.value.trim());

  // 3. mcatname — category name e.g. "Hospital Management System"
  const mcat = card.querySelector('input[name="mcatname"]');
  if (mcat) parts.push(mcat.value.trim());

  // 4. parent_mcatname — parent category e.g. "Healthcare Software"
  const pmcat = card.querySelector('input[name="parent_mcatname"]');
  if (pmcat) parts.push(pmcat.value.trim());

  // 5. All visible text in the card as final fallback
  parts.push(card.innerText?.trim() || "");

  return parts.join(" ").toLowerCase();
}

// Returns true only if the lead is from India
function isFromIndia(btn) {
  let card = btn;
  for (let i = 0; i < 10; i++) {
    card = card.parentElement;
    if (!card) break;
    const cls = card.className || "";
    if (cls.includes("lstNw") || cls.includes("BUY_") || cls.includes("f1 ")) break;
  }
  if (!card) return false;

  // Check hidden country input: <input id="card_country_1" value="India">
  const countryEl = card.querySelector('[id^="card_country_"]');
  if (countryEl) {
    const val = (countryEl.value || countryEl.dataset.val || "").toLowerCase();
    if (val && val !== "india") return false;
    if (val === "india") return true;
  }

  // Check flag ISO: <input name="flag_iso" value="in">
  const flagEl = card.querySelector('input[name="flag_iso"], [id^="flag_iso"]');
  if (flagEl) {
    const iso = (flagEl.value || "").toLowerCase();
    if (iso && iso !== "in") return false;
    if (iso === "in") return true;
  }

  return true; // no country field found — allow
}

// Exact whole-word phrase matching.
// "website" will NOT match "websites" or "ecommerce website builder".
// "software development services" will ONLY match leads containing
// that exact phrase as whole words — not just "software" somewhere.
function exactPhraseMatch(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b word boundary on both sides of the full phrase
  const regex = new RegExp("\\b" + escaped + "\\b", "i");
  return regex.test(text);
}

function getLeadTitle(btn) {
  // Walk up DOM trying multiple card class patterns
  let card = btn;
  for (let i = 0; i < 12; i++) {
    card = card.parentElement;
    if (!card) break;
    const cls = card.className || "";
    if (
      cls.includes("lstNw") || cls.includes("BUY_") ||
      cls.includes("f1 ")   || cls.includes("buy-lead") ||
      cls.includes("lead-card") || cls.match(/\bf1\b/)
    ) break;
  }
  if (!card) {
    console.log("[IndiaMART Bot] ⚠ Could not find card container for button");
    return "";
  }

  // Try multiple sources for the title in order of reliability
  const sources = [
    card.querySelector('input[name="ofrtitle"]')?.value?.trim(),
    card.querySelector('[id^="ofrtitle"]')?.value?.trim(),
    card.querySelector("h2")?.innerText?.trim(),
    card.querySelector("h3")?.innerText?.trim(),
    card.querySelector('[class*="title" i]')?.innerText?.trim(),
    card.querySelector('[class*="heading" i]')?.innerText?.trim(),
  ];

  const raw = sources.find((s) => s && s.length > 0) || "";

  console.log(`[IndiaMART Bot] 🏷 Lead title read: "${raw}"`);
  return raw;
}

function matchesFilters(btn) {
  // 1. Country check
  const india = isFromIndia(btn);
  if (!india) {
    console.log("[IndiaMART Bot] ⏭ Skipped — not from India");
    return false;
  }

  const title = getLeadTitle(btn);

  // If title is empty, log and allow the click (don't silently block)
  if (!title) {
    console.log("[IndiaMART Bot] ⚠ Empty title — allowing click (can't filter)");
    return true;
  }

  // 2. Blocklist — if ANY exclude keyword matches, skip
  if (excludeKeywords && excludeKeywords.length > 0) {
    for (const kw of excludeKeywords) {
      if (exactPhraseMatch(title, kw.trim())) {
        console.log(`[IndiaMART Bot] ⛔ BLOCKED by exclude keyword "${kw}" — title: "${title}"`);
        return false;
      }
    }
  }

  // 3. Include keyword — must match at least one
  if (keywords && keywords.length > 0) {
    const matched = keywords.find((kw) => exactPhraseMatch(title, kw.trim()));
    if (matched) {
      console.log(`[IndiaMART Bot] ✅ MATCHED keyword "${matched}" — title: "${title}"`);
      return true;
    }
    console.log(`[IndiaMART Bot] ⏭ No keyword matched — title: "${title}" | keywords: [${keywords.join(", ")}]`);
    return false;
  }

  // No keywords set — click everything from India
  return true;
}

// ─────────────────────────────────────────────────────────────────
// ANTI-IDLE  — simulates subtle mouse movement every ~30s
// Uses a hidden div moved via CSS so no real pointer jump happens
// ─────────────────────────────────────────────────────────────────
let antiIdleEl = null;

function startAntiIdle() {
  if (idleTimer) return;

  // Create an invisible element we'll dispatch mouse events on
  if (!antiIdleEl) {
    antiIdleEl = document.createElement("div");
    antiIdleEl.style.cssText =
      "position:fixed;width:1px;height:1px;top:0;left:0;opacity:0;pointer-events:none;z-index:-1";
    document.body.appendChild(antiIdleEl);
  }

  idleTimer = setInterval(() => {
    // Dispatch a mousemove event on the document with slightly varying coords
    const x = Math.floor(Math.random() * window.innerWidth  * 0.8 + window.innerWidth  * 0.1);
    const y = Math.floor(Math.random() * window.innerHeight * 0.8 + window.innerHeight * 0.1);

    document.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      screenX: x, screenY: y,
    }));

    // Also dispatch on the body and window to cover all listeners IndiaMART uses
    document.body.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: x, clientY: y,
    }));

    console.log(`[IndiaMART Bot] 🖱 Anti-idle ping (${x}, ${y})`);
  }, 25000 + Math.random() * 10000); // every 25-35s (randomised)
}

function stopAntiIdle() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

// ─────────────────────────────────────────────────────────────────
// LEAD DETECTION & CLICKING
// ─────────────────────────────────────────────────────────────────

function findContactButtons() {
  const all = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode;
    const text = el.innerText?.trim() || "";
    if (
      (text === "Contact Buyer Now" || text === "Contact Now") &&
      el.children.length === 0
    ) all.push(el);
  }
  for (const sel of [
    'button[class*="contact" i]', 'a[class*="contact" i]',
    '[class*="contactBuyer"]',    '[id*="contactBuyer"]',
  ]) {
    document.querySelectorAll(sel).forEach((el) => {
      if (!all.includes(el)) all.push(el);
    });
  }
  return all;
}

function getCardContainer(btn) {
  // Try walking up to find the card — try up to 15 levels
  let el = btn;
  for (let i = 0; i < 15; i++) {
    el = el.parentElement;
    if (!el) break;
    const cls = el.className || "";
    // Match any known IndiaMART card class pattern
    if (
      cls.includes("lstNw") || cls.includes("BUY_pr") ||
      cls.includes("buy-lead") || cls.includes("lead-card") ||
      (cls.includes("f1") && cls.includes("BUY_"))
    ) return el;
  }
  // Fallback: go 6 levels up from button regardless
  let fallback = btn;
  for (let i = 0; i < 6; i++) fallback = fallback.parentElement || fallback;
  return fallback;
}

function getLeadId(btn) {
  const card = getCardContainer(btn);

  // Search the entire card subtree for ofrid input
  // IndiaMART uses numbered IDs like ofrid1, ofrid2 etc.
  const allInputs = card.querySelectorAll('input[type="hidden"]');
  for (const inp of allInputs) {
    if (inp.name === "ofrid" || (inp.id && inp.id.startsWith("ofrid"))) {
      if (inp.value && inp.value !== "0") return inp.value.trim();
    }
  }

  // Fallback: data attributes
  const dataId = card.dataset.id || card.dataset.leadId || card.dataset.queryId;
  if (dataId) return dataId;

  // Last resort: position
  const rect = btn.getBoundingClientRect();
  return `pos_${Math.round(rect.top + window.scrollY)}_${Math.round(rect.left)}`;
}

async function closeModal() {
  await delay(600);
  const closers = [...document.querySelectorAll("button, a")].filter((el) => {
    const t = el.innerText?.trim().toLowerCase();
    return t === "ok" || t === "close" || t === "done" || t === "×" || t === "x";
  });
  for (const el of closers) {
    if (isVisible(el)) { el.click(); await delay(400); return; }
  }
  document.querySelectorAll('[aria-label="Close"], .modal-close, .popup-close, .close-btn')
    .forEach((el) => { if (isVisible(el)) el.click(); });
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== "none";
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function clickButton(btn, leadMeta) {
  // Find the card so we can scrape contact details from it after clicking
  let card = btn;
  for (let i = 0; i < 10; i++) {
    card = card.parentElement || card;
    if (!card) break;
    const cls = card.className || "";
    if (cls.includes("lstNw") || cls.includes("BUY_") || cls.includes("f1 ")) break;
  }

  btn.scrollIntoView({ behavior: "smooth", block: "center" });
  await delay(400);
  btn.click();
  await delay(CLICK_DELAY_MS);
  await closeModal();

  // Extract contact details that IndiaMART reveals after clicking
  const contact = await extractContactDetails(card);

  // Build payload and send to webhook
  const payload = {
    timestamp:  new Date().toISOString(),
    leadId:     leadMeta.id,
    title:      leadMeta.title,
    phone:      contact.phone,
    email:      contact.email,
    buyerName:  contact.buyerName,
    city:       contact.city,
    country:    "India",
    pageUrl:    location.href,
  };

  console.log(`[${timestamp()}] 📋 Contact extracted — phone: ${contact.phone || "—"} | email: ${contact.email || "—"}`);

  await sendToWebhook(payload);
}


// ── Extract contact details after clicking ─────────────────────────
// IndiaMART reveals phone/email in the card or a modal after clicking.
async function extractContactDetails(card) {
  // Wait up to 4s for contact details to appear
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await delay(400);

    // Phone: look for 10-digit Indian numbers or formatted versions
    const phoneMatch = card.innerText.match(/(?:\+91[\s-]?)?[6-9]\d{9}/);

    // Email: standard email pattern
    const emailMatch = card.innerText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);

    // Buyer name: often in a <strong> or specific class after reveal
    let buyerName = "";
    const nameEl =
      card.querySelector('[class*="buyer" i] strong, [class*="name" i] strong') ||
      card.querySelector('[class*="contName"], [class*="cont_name"]');
    if (nameEl) buyerName = nameEl.innerText.trim();

    // City
    let city = "";
    const cityEl = card.querySelector('[id^="card_city_"], [class*="city" i]');
    if (cityEl) city = (cityEl.value || cityEl.innerText || "").trim();

    if (phoneMatch || emailMatch) {
      return {
        phone:     phoneMatch ? phoneMatch[0] : null,
        email:     emailMatch ? emailMatch[0] : null,
        buyerName: buyerName || null,
        city:      city || null,
      };
    }
  }
  return { phone: null, email: null, buyerName: null, city: null };
}

// ── POST lead data to webhook ──────────────────────────────────────
// Delegates to background service worker to avoid IndiaMART's CSP
// blocking fetch() calls from content scripts to http://localhost
async function sendToWebhook(payload) {
  if (!webhookUrl) {
    console.warn(`[${timestamp()}] ⚠ No webhook URL set — skipping POST`);
    return;
  }
  try {
    // Send to background service worker which has no CSP restrictions
    chrome.runtime.sendMessage({
      type:    "POST_WEBHOOK",
      url:     webhookUrl,
      payload: payload,
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(`[${timestamp()}] ⚠ Background message error: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (response?.ok) {
        console.log(`[${timestamp()}] 📤 Sent to webhook — ${payload.title}`);
      } else {
        console.warn(`[${timestamp()}] ⚠ Webhook failed — ${response?.error}`);
      }
    });
  } catch (err) {
    console.warn(`[${timestamp()}] ⚠ sendToWebhook error: ${err.message}`);
  }
}

function timestamp() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

async function scanAndClick() {
  if (!enabled) return;

  const buttons = findContactButtons();
  let newClicks = 0;

  for (const btn of buttons) {
    const id = getLeadId(btn);
    if (clickedIds.has(id)) continue;
    if (!isVisible(btn)) continue;

    // Get title independently — don't fall back to card ID (e.g. "BLCard1")
    const title = getLeadTitle(btn) || "Unknown Lead";

    // ── Filters (country + keyword) ────────────────────────────
    if (!matchesFilters(btn)) {
      // Only log skips once per lead, not every scan cycle
      if (!clickedIds.has(id)) {
        console.log(`[${timestamp()}] ⏭ SKIPPED — "${title}"`);
      }
      clickedIds.add(id);
      continue;
    }

    // ── Lead detected — log before clicking ───────────────────
    console.log(`[${timestamp()}] 🔍 LEAD DETECTED — "${title}" [id: ${id}]`);

    clickedIds.add(id);
    await clickButton(btn, { id, title });
    newClicks++;
    totalClicked++;

    console.log(`[${timestamp()}] ✅ CLICKED "Contact Buyer Now" — "${title}"`);

    chrome.storage.local.set({ totalClicked });
    chrome.runtime.sendMessage({ type: "CLICKED", totalClicked }).catch(() => {});
  }

  if (newClicks > 0) {
    console.log(`[${timestamp()}] 📊 ${newClicks} lead(s) contacted this scan | Total ever: ${totalClicked}`);
  }
}

// ── Mutation observer + interval ───────────────────────────────────
let observer = null;

function startWatching() {
  if (observer) return;
  scanAndClick();
  observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAndClick, 800);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scanTimer = setInterval(scanAndClick, SCAN_INTERVAL);
  console.log("[IndiaMART Bot] 👀 Watching for leads…");
}

function stopWatching() {
  if (observer) { observer.disconnect(); observer = null; }
  if (scanTimer) { clearInterval(scanTimer); clearTimeout(scanTimer); scanTimer = null; }
  console.log("[IndiaMART Bot] ⏸ Paused.");
}

// ── SPA navigation detection ───────────────────────────────────────
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    clickedIds.clear();
    if (enabled) { stopWatching(); setTimeout(startWatching, 1500); }
  }
}).observe(document, { subtree: true, childList: true });
