const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Idempotency-Key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PROJECT_ID = "topuppro-4b458";
const RTDB_URL = "https://topuppro-4b458-default-rtdb.firebaseio.com";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyDcgQ0mzOfQhqyywHHfiJoxc12dfS9fbyQ";
const DEFAULT_REDIRECT = process.env.DEFAULT_REDIRECT_URL || "https://topuppro-4b458.web.app";

const executionLocks = new Set();
const ipRateLimitMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of ipRateLimitMap.entries()) if (now > v.resetAt) ipRateLimitMap.delete(ip);
}, 300000);

function checkRateLimit(ip, limit = 45, windowMs = 60000) {
  const now = Date.now(), e = ipRateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > e.resetAt) { e.count = 1; e.resetAt = now + windowMs; } else e.count++;
  ipRateLimitMap.set(ip, e);
  return e.count <= limit;
}

async function rawRequest(url, options = {}) {
  if (typeof fetch !== "undefined") {
    try {
      const r = await fetch(url, options), txt = await r.text();
      let data = null; try { data = JSON.parse(txt); } catch {}
      return { status: r.status, ok: r.ok, data, etag: r.headers.get("etag") };
    } catch { return { status: 0, ok: false, data: null, etag: null }; }
  }
  return new Promise((resolve) => {
    try {
      const u = new URL(url), cli = u.protocol === "https:" ? https : http;
      const req = cli.request({
        hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, method: options.method || "GET", headers: options.headers || {}
      }, (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          let data = null; try { data = JSON.parse(d); } catch {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, etag: res.headers["etag"] || null });
        });
      });
      req.on("error", () => resolve({ status: 0, ok: false, data: null, etag: null }));
      req.setTimeout(9000, () => { req.destroy(); resolve({ status: 0, ok: false, data: null, etag: null }); });
      if (options.body) req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      req.end();
    } catch { resolve({ status: 0, ok: false, data: null, etag: null }); }
  });
}

const fbGet = async (u) => (await rawRequest(u)).data;
const fbJson = async (u, m, b) => (await rawRequest(u, { method: m, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).data;
const fsStr = v => ({ stringValue: String(v ?? "") });
const fsDbl = v => ({ doubleValue: Number(v) || 0 });
const fsInt = v => ({ integerValue: String(Math.round(Number(v) || 0)) });
const fsTs = () => ({ timestampValue: new Date().toISOString() });
const fsNumVal = f => parseFloat(f?.doubleValue ?? f?.integerValue ?? f?.stringValue ?? 0) || 0;

async function rtdbAtomicTransaction(nodePath, mutatorFn) {
  for (let i = 0; i < 4; i++) {
    const g = await rawRequest(`${RTDB_URL}/${nodePath}.json`, { method: "GET", headers: { "X-Firebase-ETag": "true" } });
    if (!g.ok && g.status !== 404) return { committed: false, data: null };
    const next = mutatorFn(g.data);
    if (next === undefined) return { committed: false, aborted: true, data: g.data };
    const headers = { "Content-Type": "application/json" };
    if (g.etag) headers["If-Match"] = g.etag;
    const p = await rawRequest(`${RTDB_URL}/${nodePath}.json`, { method: "PUT", headers, body: JSON.stringify(next) });
    if (p.ok) return { committed: true, data: p.data || next, prevData: g.data };
    if (p.status !== 412) return { committed: false, data: null };
  }
  return { committed: false, data: null };
}

const escapeHtml = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const sanitizeSafeUrl = u => { const t = String(u || "").trim(); return (/^https?:\/\//i.test(t) || t.startsWith("/")) ? t : DEFAULT_REDIRECT; };
const sanitizeRtdbKey = s => String(s || "").trim().replace(/[.#$\[\]\/]/g, "_");
const sanitizeText = s => s ? String(s).replace(/[<>'"&]/g, "").trim() : "";
const bn2en = s => String(s || "").replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d));

function extractPureTrxId(raw) {
  if (!raw) return "";
  return bn2en(raw).trim().toUpperCase()
    .replace(/^(?:TRXID|TXNID|TXN_ID|TRX_ID|TRX|TXN|ID|TRANS|TRANSACTION)[:\s#-]*/i, "")
    .replace(/^[^\w-]+|[^\w-]+$/g, "").replace(/\s+/g, "");
}
function cleanOrderDetails(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
function detailsSafe(v) {
  if (!v) return "";
  if (typeof v === "object") return escapeHtml(v.name || v.title || JSON.stringify(v));
  return escapeHtml(String(v).trim());
}
function safeBrandKey(m) {
  const s = String(m || "bkash").toLowerCase().trim();
  if (/bkash|বিকাশ/.test(s)) return "bkash";
  if (/nagad|নগদ/.test(s)) return "nagad";
  if (/rocket|রকেট|dbbl/.test(s)) return "rocket";
  if (/upay|উপায়|উপায়/.test(s)) return "upay";
  if (/binance|usdt/.test(s)) return "binance";
  if (/premium|প্রিমিয়াম/.test(s)) return "premium";
  return "bkash";
}
function validateMethodFormat(trx, method) {
  const m = safeBrandKey(method);
  if (trx.includes("_") || trx.startsWith("GIFT")) return { valid: true, isBonus: true };
  if (m === "bkash" && !/^[A-Z0-9]{8,14}$/.test(trx)) {
    if (/^[0-9]+$/.test(trx)) return { valid: false, message: "❌ এটি রকেটের নম্বর! বিকাশ TrxID অক্ষর ও সংখ্যার কোড হতে হবে।" };
    return { valid: false, message: "❌ বিকাশ TrxID ৮-১৪ অক্ষরের (যেমন: BLG789ABCD) হতে হবে।" };
  }
  if (m === "nagad" && !/^[A-Z0-9]{7,14}$/.test(trx)) {
    if (/^[0-9]{9,16}$/.test(trx)) return { valid: false, message: "❌ এটি রকেটের নম্বর! নগদ TxnID অক্ষর-সংখ্যা মিশ্রিত কোড হতে হবে।" };
    return { valid: false, message: "❌ নগদ TxnID ৭-১৪ অক্ষরের (যেমন: 7K89ABCD) হতে হবে।" };
  }
  if (m === "rocket" && !/^[A-Z0-9]{8,18}$/.test(trx)) return { valid: false, message: "❌ রকেট TxnId ৮-১৮ ডিজিটের (যেমন: 3876543210) হতে হবে।" };
  if (m === "upay" && !/^[A-Z0-9]{7,20}$/.test(trx)) return { valid: false, message: "❌ উপায় TxnID ৭-২০ অক্ষরের হতে হবে।" };
  if (m === "binance" && !/^[A-Z0-9-]{6,26}$/.test(trx)) return { valid: false, message: "❌ Binance Pay Order/Pay ID কমপক্ষে ৬ অক্ষরের হতে হবে।" };
  if (m === "premium" && !/^[A-Z0-9-]{6,24}$/.test(trx)) return { valid: false, message: "❌ Premium Transaction ID কমপক্ষে ৬ অক্ষরের হতে হবে।" };
  return { valid: true, isBonus: false };
}

function findMatchingSmsInPool(smsData, cleanTrx, expectedAmount, requestedMethod, tolVal = 0) {
  if (!smsData || typeof smsData !== "object") return { notFound: true };
  const reqBrand = safeBrandKey(requestedMethod);
  const tol = reqBrand === "binance" ? 0 : Math.max(0, Number(tolVal) || 0);
  let crossBrand = null;

  for (const [key, item] of Object.entries(smsData).reverse()) {
    if (!item || item.used === true || item.used === "true" || item.match_status === "MATCHED") continue;
    if (extractPureTrxId(item.parsed_trx || "") !== cleanTrx) continue;
    const itemBrand = safeBrandKey(item.brandKey || item.brand || "");
    if (itemBrand !== reqBrand) { crossBrand = item.brand || "অন্য মেথড"; continue; }
    const amt = parseFloat(item.parsed_amount) || parseFloat(item.amount) || 0;
    if (amt > 0) {
      if (Math.abs(amt - expectedAmount) <= tol) return { success: true, key, matchedBrand: item.brand || requestedMethod, amount: amt };
      return { mismatch: true, error: `টাকার অঙ্ক মেলেনি! ইনভয়েস ৳${expectedAmount}, প্রাপ্ত SMS-এ ৳${amt} এসেছে।` };
    }
  }
  if (crossBrand) return { mismatch: true, error: `❌ মেথড অমিল! এটি [${crossBrand}]-এর ট্রানজেকশন। আপনি [${requestedMethod.toUpperCase()}] ঘরে দিয়েছেন!` };
  return { notFound: true };
}

const logAdmin = (action, details) => fbJson(`${RTDB_URL}/admin_logs.json`, "POST", { action, details, timestamp: Date.now() }).catch(()=>{});

// Double-Layer Atomic Fulfillment Engine (Strictly Separate Direct Order vs Add Balance + Rollback)
async function executeFulfillment(invoiceId, cleanTrx, amount, brand = "bKash", smsKey = null, isBonus = false) {
  if (!invoiceId) return { ok: false, reason: "ইনভয়েস আইডি পাওয়া যায়নি!" };
  const safeTrx = sanitizeRtdbKey(cleanTrx);
  if (executionLocks.has(invoiceId) || executionLocks.has(safeTrx)) return { ok: false, reason: "ট্রানজেকশনটি বর্তমানে প্রসেসিং অবস্থায় আছে।" };
  executionLocks.add(invoiceId); executionLocks.add(safeTrx);

  let procLocked = false, invLocked = false, smsLocked = false;
  try {
    const procLock = await rtdbAtomicTransaction(`processed_trx/${safeTrx}`, c => (c !== null && c.invoice_id !== invoiceId) ? undefined : {
      invoice_id: invoiceId, trx_id: cleanTrx, amount, method: brand, verified_at: Date.now(), verified_by: isBonus ? "BONUS_VOUCHER" : "GATEWAY_AUTO", status: "COMPLETED"
    });
    if (!procLock.committed) return { ok: false, reason: "❌ এই TrxID-টি ইতিমধ্যে অন্য একটি পেমেন্টে ব্যবহার করা হয়েছে! একটি ট্রানজ্যাকশন দুইবার ব্যবহার করা যাবে না।" };
    procLocked = true;

    const invLock = await rtdbAtomicTransaction(`invoices/${invoiceId}`, c => (!c || ["PAID","APPROVED","COMPLETED","SUCCESS"].includes(String(c.status||"").toUpperCase())) ? undefined : {
      ...c, status: "PAID", trx_id: cleanTrx, method: brand, is_bonus: !!isBonus, paidAt: Date.now(), verifiedBy: isBonus ? "BONUS_VOUCHER" : "GATEWAY_AUTO"
    });
    if (!invLock.committed || !invLock.prevData) {
      await rawRequest(`${RTDB_URL}/processed_trx/${safeTrx}.json`, { method: "DELETE" });
      return { ok: false, reason: "⚠️ এই ইনভয়েসের পেমেন্ট ইতিমধ্যে সম্পন্ন হয়েছে!" };
    }
    invLocked = true;
    const inv = invLock.prevData;

    if (smsKey) {
      await fbJson(`${RTDB_URL}/sms_pool/${smsKey}.json`, "PATCH", { used: true, match_status: "MATCHED", matched_invoice: invoiceId, used_by_invoice: invoiceId, verified_at: new Date().toISOString() });
      smsLocked = true;
    }

    const userId = inv.userId || inv.user_id || inv.uid || "";
    const userEmail = inv.userEmail || inv.email || "Customer";
    const numAmt = parseFloat(inv.amount) || amount;
    const details = cleanOrderDetails(inv.order_details);
    const normType = String(inv.order_type || "").toUpperCase().trim();
    const isDirect = normType === "DIRECT_ORDER" || normType.includes("ORDER") || normType.includes("DIRECT") || !!(details && (details.gameName || details.productName || details.product || details.playerId));

    let updatedBalance = null, fsOk = true;
    if (isDirect) {
      const exId = details ? (details.orderId || details.order_id || details.id) : null;
      if (exId) {
        fsOk = (await rawRequest(`${FS_BASE}/orders/${exId}?updateMask.fieldPaths=status&updateMask.fieldPaths=paymentStatus&updateMask.fieldPaths=trxId&key=${API_KEY}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { status: fsStr("processing"), paymentStatus: fsStr("paid"), trxId: fsStr(cleanTrx) } })
        })).ok;
      } else {
        const orderId = `ORD_${invoiceId}`, prodName = (details && ((details.product && details.product.name) || details.productName || (typeof details.product === "string" ? details.product : "Diamond Package"))) || "Diamond Package";
        const orderFields = {
          orderId: fsStr(orderId), invoiceId: fsStr(invoiceId), userId: fsStr(userId), userName: fsStr(userEmail), userEmail: fsStr(userEmail),
          gameId: fsStr(details?.gameId), gameName: fsStr(details?.gameName || "Game Order"), productName: fsStr(prodName),
          price: fsInt(numAmt), playerId: fsStr(details?.playerId), type: fsStr(details?.type || "uid"),
          status: fsStr("processing"), paymentStatus: fsStr("paid"), apiStatus: fsStr("pending_api"),
          paymentMethod: fsStr(brand + " (Direct Gateway)"), trxId: fsStr(cleanTrx), date: fsTs()
        };
        if (details?.zoneId) orderFields.zoneId = fsStr(details.zoneId);
        if (details?.accountType) orderFields.accountType = fsStr(details.accountType);
        if (details?.contactPhone) orderFields.contactPhone = fsStr(details.contactPhone);

        fsOk = (await rawRequest(`${FS_BASE}:commit?key=${API_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ writes: [
            { currentDocument: { exists: false }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/orders/${orderId}`, fields: orderFields } },
            { currentDocument: { exists: false }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/transactions/TX_${invoiceId}`, fields: {
              txId: fsStr(`TX_${invoiceId}`), type: fsStr("DIRECT_ORDER"), userId: fsStr(userId), userEmail: fsStr(userEmail),
              amount: fsDbl(numAmt), method: fsStr(brand), trxId: fsStr(cleanTrx), invoiceId: fsStr(invoiceId), orderId: fsStr(orderId), status: fsStr("SUCCESS"), createdAt: fsTs()
            }}}
          ]})
        })).ok;
      }
    } else if (userId) {
      fsOk = false;
      for (let r = 0; r < 3; r++) {
        const uDoc = await fbGet(`${FS_BASE}/users/${userId}?key=${API_KEY}`);
        if (!uDoc?.fields) break;
        const curBal = fsNumVal(uDoc.fields.balance), newBal = Number((curBal + numAmt).toFixed(2));
        updatedBalance = newBal;
        const cRes = await rawRequest(`${FS_BASE}:commit?key=${API_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ writes: [
            { currentDocument: { updateTime: uDoc.updateTime }, updateMask: { fieldPaths: ["balance"] }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/users/${userId}`, fields: { balance: fsDbl(newBal) } } },
            { currentDocument: { exists: false }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/deposits/DEP_${invoiceId}`, fields: {
              depositId: fsStr(`DEP_${invoiceId}`), invoiceId: fsStr(invoiceId), userId: fsStr(userId), userEmail: fsStr(userEmail),
              amount: fsDbl(numAmt), previousBalance: fsDbl(curBal), newBalance: fsDbl(newBal), method: fsStr(brand),
              senderPhone: fsStr("Auto Verified"), trxId: fsStr(cleanTrx), status: fsStr("approved"), date: fsTs()
            }}},
            { currentDocument: { exists: false }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/transactions/TX_${invoiceId}`, fields: {
              txId: fsStr(`TX_${invoiceId}`), type: fsStr("ADD_BALANCE"), userId: fsStr(userId), userEmail: fsStr(userEmail),
              amount: fsDbl(numAmt), previousBalance: fsDbl(curBal), newBalance: fsDbl(newBal), method: fsStr(brand),
              trxId: fsStr(cleanTrx), invoiceId: fsStr(invoiceId), status: fsStr("SUCCESS"), createdAt: fsTs()
            }}}
          ]})
        });
        if (cRes.ok) { fsOk = true; break; }
        if (cRes.status !== 409) break;
      }
    }

    if (!isDirect && !userId) fsOk = false;
    if (!fsOk) {
      if (invLocked) await fbJson(`${RTDB_URL}/invoices/${invoiceId}.json`, "PATCH", { status: "PENDING", paidAt: null, verifiedBy: null });
      if (procLocked) await rawRequest(`${RTDB_URL}/processed_trx/${safeTrx}.json`, { method: "DELETE" });
      if (smsLocked && smsKey) await fbJson(`${RTDB_URL}/sms_pool/${smsKey}.json`, "PATCH", { used: false, match_status: "UNMATCHED", matched_invoice: null });
      return { ok: false, reason: "ব্যালেন্স আপডেটে অস্থায়ী সমস্যা হয়েছে, আবার চেষ্টা করুন।" };
    }

    await rtdbAtomicTransaction(`notifications/${invoiceId}`, c => c !== null ? undefined : {
      userId, title: "Payment Successful!", message: isDirect ? "Your product order has been confirmed." : "Your balance has been added successfully.",
      invoiceId, trxId: cleanTrx, amount: numAmt, method: brand, updatedBalance, type: "SUCCESS", createdAt: Date.now()
    });
    await fbJson(`${RTDB_URL}/live_fulfillment_feed.json`, "POST", {
      invoiceId, userId, userEmail, orderType: isDirect ? "DIRECT_ORDER" : "ADD_BALANCE", orderDetails: isDirect ? details : null,
      amount: numAmt, trxId: cleanTrx, method: brand, status: "APPROVED", timestamp: Date.now(), timeStr: new Date().toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit" })
    }).catch(()=>{});
    await logAdmin(isBonus ? "BONUS_REDEEM" : "GATEWAY_AUTO_APPROVE", `Invoice ${invoiceId} (${cleanTrx}) ৳${numAmt} via ${brand} [${userEmail}]`);
    return { ok: true, updatedBalance, verifiedAt: Date.now(), redirectUrl: sanitizeSafeUrl(inv.redirect_url) };
  } catch {
    if (invLocked) await fbJson(`${RTDB_URL}/invoices/${invoiceId}.json`, "PATCH", { status: "PENDING", paidAt: null, verifiedBy: null }).catch(()=>{});
    if (procLocked) await rawRequest(`${RTDB_URL}/processed_trx/${safeTrx}.json`, { method: "DELETE" }).catch(()=>{});
    return { ok: false, reason: "সার্ভার প্রসেসিং এরর।" };
  } finally {
    setTimeout(() => { executionLocks.delete(invoiceId); executionLocks.delete(safeTrx); }, 15000);
  }
}

app.get("/", (req, res) => res.send("<h1 style='font-family:sans-serif;text-align:center;margin-top:60px'>🚀 TopUpPro 6-Gateway Atomic Server Online</h1>"));
app.get("/api/health", (req, res) => res.json({ ok: true, uptime: process.uptime(), timestamp: Date.now() }));
app.get("/api/gateways", async (req, res) => res.json((await fbGet(`${RTDB_URL}/settings/gateways.json`)) || {}));

// 1. CREATE PAYMENT API
app.all(["/api/create-payment", "/api/payment/create", "/create-payment"], async (req, res) => {
  try {
    const d = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const amt = Math.max(1, Math.min(100000, parseFloat(String(d.amount || 500).replace(/[^0-9.]/g, "")) || 500));
    const meta = d.metadata || {}, userId = sanitizeText(meta.userId || d.userId || d.uid || "");
    const userEmail = sanitizeText(d.email || d.user_email || "Customer");
    const idemKey = sanitizeRtdbKey(req.headers["x-idempotency-key"] || d.idempotencyKey || "");
    const details = cleanOrderDetails(meta.orderDetails || d.order_details || meta.order_details || d.orderDetails);
    const rawType = String(meta.orderType || d.order_type || meta.order_type || d.orderType || "").toUpperCase();
    const orderType = (rawType.includes("ORDER") || rawType.includes("DIRECT") || rawType.includes("PRODUCT") || !!(details && (details.gameName || details.productName || details.product))) ? "DIRECT_ORDER" : "ADD_BALANCE";
    const redirect_url = sanitizeSafeUrl(d.redirect_url), host = req.headers.host || "localhost:3000", proto = req.headers["x-forwarded-proto"] || "http";

    if (idemKey) {
      const idem = await fbGet(`${RTDB_URL}/idempotency/${idemKey}.json`);
      if (idem?.invoice_id) return res.json({ status: true, message: "Payment Initiated", invoice_id: idem.invoice_id, payment_url: `${proto}://${host}/checkout?invoice_id=${idem.invoice_id}` });
    }
    const invoice_id = "TPP" + Date.now().toString().slice(-10) + crypto.randomInt(10, 99);
    await fbJson(`${RTDB_URL}/invoices/${invoice_id}.json`, "PUT", { invoice_id, amount: amt, userId, userEmail, order_type: orderType, order_details: details, redirect_url, status: "PENDING", createdAt: Date.now(), expiresAt: Date.now() + 15 * 60 * 1000 });
    if (idemKey) await fbJson(`${RTDB_URL}/idempotency/${idemKey}.json`, "PUT", { invoice_id, createdAt: Date.now() });
    return res.json({ status: true, message: "Payment Initiated", invoice_id, payment_url: `${proto}://${host}/checkout?invoice_id=${invoice_id}` });
  } catch { return res.status(500).json({ status: false, message: "ইনভয়েস তৈরি করা যায়নি।" }); }
});

// 2. WALLET PRODUCT PURCHASE API (Separate from Add Balance)
app.post("/api/purchase-product", async (req, res) => {
  try {
    const { userId, userEmail, productId, playerId, idempotencyKey } = req.body || {};
    const uid = sanitizeText(userId), pid = sanitizeText(productId), pl = sanitizeText(playerId), idem = sanitizeRtdbKey(req.headers["x-idempotency-key"] || idempotencyKey || "");
    if (!uid || !pid || !pl || !idem) return res.status(400).json({ status: false, message: "প্রয়োজনীয় তথ্য অসম্পূর্ণ।" });

    const orderId = `ORD_${idem}`;
    if ((await fbGet(`${FS_BASE}/orders/${orderId}?key=${API_KEY}`))?.fields) return res.json({ status: true, alreadyCreated: true, orderId, message: "অর্ডারটি ইতিমধ্যে তৈরি হয়েছে!" });
    const prod = await fbGet(`${FS_BASE}/products/${pid}?key=${API_KEY}`);
    if (!prod?.fields) return res.status(404).json({ status: false, message: "পণ্যটি পাওয়া যায়নি।" });
    if (prod.fields.available?.booleanValue === false) return res.status(400).json({ status: false, message: "পণ্যটি স্টকে নেই।" });

    const prodName = prod.fields.name?.stringValue || "Product", prodCat = prod.fields.category?.stringValue || "Game", price = fsNumVal(prod.fields.price);
    if (price <= 0) return res.status(400).json({ status: false, message: "পণ্যের মূল্য সঠিক নয়।" });

    const uDoc = await fbGet(`${FS_BASE}/users/${uid}?key=${API_KEY}`);
    if (!uDoc?.fields) return res.status(404).json({ status: false, message: "ইউজার পাওয়া যায়নি।" });
    if (uDoc.fields.blocked?.booleanValue === true) return res.status(403).json({ status: false, message: "অ্যাকাউন্ট ব্লক করা হয়েছে।" });

    const prevBal = fsNumVal(uDoc.fields.balance);
    if (prevBal < price) return res.status(400).json({ status: false, message: `পর্যাপ্ত ব্যালেন্স নেই! প্রয়োজন ৳${price}, আছে ৳${prevBal}` });
    const newBal = Number((prevBal - price).toFixed(2));

    const cRes = await rawRequest(`${FS_BASE}:commit?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ writes: [
        { currentDocument: { updateTime: uDoc.updateTime }, updateMask: { fieldPaths: ["balance"] }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`, fields: { balance: fsDbl(newBal) } } },
        { currentDocument: { exists: false }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/orders/${orderId}`, fields: {
          orderId: fsStr(orderId), userId: fsStr(uid), userEmail: fsStr(sanitizeText(userEmail || uDoc.fields.email?.stringValue)),
          productId: fsStr(pid), productName: fsStr(prodName), category: fsStr(prodCat), price: fsDbl(price),
          playerId: fsStr(pl), status: fsStr("pending"), paymentStatus: fsStr("paid"), paymentMethod: fsStr("Wallet Balance"), date: fsTs()
        }}},
        { currentDocument: { exists: false }, update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/transactions/TX_${orderId}`, fields: {
          txId: fsStr(`TX_${orderId}`), type: fsStr("PRODUCT_PURCHASE"), userId: fsStr(uid), amount: fsDbl(-price),
          previousBalance: fsDbl(prevBal), newBalance: fsDbl(newBal), orderId: fsStr(orderId), status: fsStr("SUCCESS"), createdAt: fsTs()
        }}}
      ]})
    });
    if (!cRes.ok) return res.status(409).json({ status: false, message: "ব্যালেন্স পরিবর্তিত হয়েছে। আবার চেষ্টা করুন।" });
    return res.json({ status: true, orderId, newBalance: newBal, productName: prodName, price, message: "অর্ডার সফলভাবে সম্পন্ন হয়েছে!" });
  } catch (err) { return res.status(500).json({ status: false, message: "অর্ডার এরর: " + err.message }); }
});

// 3. CHECK STATUS API
app.get("/api/check-status", async (req, res) => {
  const id = sanitizeText(req.query.invoice_id);
  if (!id) return res.json({ status: "UNKNOWN" });
  try {
    const inv = await fbGet(`${RTDB_URL}/invoices/${id}.json`);
    if (!inv) return res.json({ status: "NOT_FOUND" });
    const st = String(inv.status || "PENDING").toUpperCase();
    let updatedBalance = null;
    if (["PAID","APPROVED","COMPLETED","SUCCESS"].includes(st) && inv.userId) {
      const u = await fbGet(`${FS_BASE}/users/${inv.userId}?key=${API_KEY}`);
      if (u?.fields?.balance) updatedBalance = fsNumVal(u.fields.balance);
    }
    return res.json({ status: st, paymentStatus: ["PAID","APPROVED","COMPLETED","SUCCESS"].includes(st) ? "SUCCESS" : st, trxId: inv.trx_id || "", amount: inv.amount, method: inv.method || "", updatedBalance, paidAt: inv.paidAt || null, redirect_url: sanitizeSafeUrl(inv.redirect_url) });
  } catch { return res.json({ status: "ERROR" }); }
});

// 4. STRICT SINGLE-USE VERIFY PAYMENT API (এক TrxID দুইবার দেওয়া যাবে না)
app.all(["/api/verify-trx", "/api/verify-payment"], async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    if (!checkRateLimit(ip)) return res.status(429).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "অতিরিক্ত চেষ্টা! ১ মিনিট পর চেষ্টা করুন।" });

    const d = req.method === "POST" ? (req.body || {}) : (req.query || {});
    let invoice_id = sanitizeText(d.invoice_id);
    const method = sanitizeText(d.method || "bKash"), brandKey = safeBrandKey(method);
    const cleanTrx = extractPureTrxId(d.trxid || d.trx_id || "");

    if (!cleanTrx || cleanTrx.length < 4) return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "দয়া করে সঠিক Transaction ID লিখুন!" });
    const fmt = validateMethodFormat(cleanTrx, brandKey);
    if (!fmt.valid) return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: fmt.message });

    if (!invoice_id) {
      const directAmt = Math.max(1, Math.min(100000, parseFloat(d.amount) || 500));
      invoice_id = "TPP" + Date.now().toString().slice(-10) + crypto.randomInt(10, 99);
      await fbJson(`${RTDB_URL}/invoices/${invoice_id}.json`, "PUT", { invoice_id, amount: directAmt, userId: sanitizeText(d.userId), userEmail: sanitizeText(d.email || "Customer"), order_type: "ADD_BALANCE", status: "PENDING", createdAt: Date.now(), expiresAt: Date.now() + 15 * 60 * 1000 });
    }

    const inv = await fbGet(`${RTDB_URL}/invoices/${invoice_id}.json`);
    if (!inv) return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "ইনভয়েস খুঁজে পাওয়া যায়নি!" });

    const st = String(inv.status || "").toUpperCase();
    if (["PAID","APPROVED","COMPLETED","SUCCESS"].includes(st)) {
      return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "⚠️ এই ইনভয়েসের পেমেন্ট ইতিমধ্যে সফল হয়েছে! একই ইনভয়েসে দুইবার পেমেন্ট করা যাবে না।" });
    }
    if (st === "REJECTED") return res.json({ status: false, paymentStatus: "REJECTED", title: "Payment Failed!", message: "❌ অ্যাডমিন এই ইনভয়েসটি বাতিল করেছেন।" });
    if (inv.expiresAt && Date.now() > inv.expiresAt) {
      await fbJson(`${RTDB_URL}/invoices/${invoice_id}.json`, "PATCH", { status: "EXPIRED" });
      return res.json({ status: false, paymentStatus: "EXPIRED", title: "Payment Failed!", message: "⏰ ইনভয়েসের মেয়াদ শেষ (Expired)!" });
    }

    const gw = await fbGet(`${RTDB_URL}/settings/gateways/${brandKey}.json`);
    if (gw && gw.enabled === false) return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "এই পেমেন্ট মেথডটি বর্তমানে বন্ধ আছে।" });
    const expAmt = parseFloat(inv.amount) || 0;
    if (gw && ((gw.min_amount && expAmt < Number(gw.min_amount)) || (gw.max_amount && expAmt > Number(gw.max_amount)))) {
      return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: `এই মেথডে সর্বনিম্ন ৳${gw.min_amount} এবং সর্বোচ্চ ৳${gw.max_amount} পেমেন্ট করা যায়।` });
    }

    // কঠোর ডুপ্লিকেট লক ১: ইতিমধ্যে সফল হওয়া TrxID
    const safeTrx = sanitizeRtdbKey(cleanTrx);
    const lock = await fbGet(`${RTDB_URL}/processed_trx/${safeTrx}.json`);
    if (lock && (lock.status === "COMPLETED" || lock.verified_at)) {
      await logAdmin("DUPLICATE_TRX_BLOCKED", `Blocked duplicate Trx ${cleanTrx} on ${invoice_id}`);
      await fbJson(`${RTDB_URL}/admin_alerts.json`, "POST", { type: "DUPLICATE_TRX_BLOCKED", sender: inv.userEmail || "Customer", sms: `Invoice ${invoice_id} | Trx: ${cleanTrx}`, reason: "একই TrxID দ্বিতীয়বার ব্যবহারের চেষ্টা", isFake: true, timestamp: Date.now() }).catch(()=>{});
      return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "❌ এই TrxID-টি ইতিমধ্যে অন্য একটি পেমেন্টে ব্যবহার করা হয়েছে! একটি ট্রানজ্যাকশন একাধিকবার ব্যবহার করা যাবে না।" });
    }

    const releaseSub = () => rawRequest(`${RTDB_URL}/submitted_trx/${safeTrx}.json`, { method: "DELETE" }).catch(()=>{});
    // কঠোর ডুপ্লিকেট লক ২: অন্য সক্রিয় পেন্ডিং ইনভয়েসে যেন একই TrxID দুইবার না যায়
    let subLock = await rtdbAtomicTransaction(`submitted_trx/${safeTrx}`, c => {
      if (c !== null && c.invoice_id && c.invoice_id !== invoice_id) return undefined;
      return { invoice_id, trx_id: cleanTrx, method: brandKey, submittedAt: Date.now() };
    });
    if (!subLock.committed && subLock.data?.invoice_id) {
      const prevInv = await fbGet(`${RTDB_URL}/invoices/${subLock.data.invoice_id}.json`);
      const prevSt = String(prevInv?.status || "").toUpperCase();
      const prevExpired = !prevInv || ["EXPIRED","REJECTED","FAILED"].includes(prevSt) || (prevInv.expiresAt && Date.now() > prevInv.expiresAt && prevSt === "PENDING");
      if (prevExpired) {
        await fbJson(`${RTDB_URL}/submitted_trx/${safeTrx}.json`, "PUT", { invoice_id, trx_id: cleanTrx, method: brandKey, submittedAt: Date.now() });
        subLock = { committed: true };
      }
    }
    if (!subLock.committed) {
      await logAdmin("DUPLICATE_PENDING_TRX", `Blocked Trx ${cleanTrx} already claimed by another pending invoice`);
      return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "❌ এই TrxID-টি ইতিমধ্যে অন্য একটি অর্ডারে জমা দেওয়া হয়েছে! একটি ট্রানজ্যাকশন দুইবার দেওয়া যাবে না।" });
    }

    // Bonus Vouchers Check
    let matchedVKey = null, vSnap = await fbGet(`${RTDB_URL}/bonus_vouchers/${safeTrx}.json`);
    if (vSnap && typeof vSnap === "object") matchedVKey = safeTrx;
    else {
      const allV = await fbGet(`${RTDB_URL}/bonus_vouchers.json`);
      if (allV && typeof allV === "object") {
        for (const [k, v] of Object.entries(allV)) {
          if (v && (extractPureTrxId(k) === cleanTrx || extractPureTrxId(v.trx_id || k) === cleanTrx)) { matchedVKey = k; vSnap = v; break; }
        }
      }
    }
    if (vSnap && matchedVKey) {
      if (vSnap.used === true || vSnap.status === "CLAIMED") { await releaseSub(); return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "❌ এই বোনাস/গিফট কোডটি ইতিমধ্যে ব্যবহার করা হয়েছে!" }); }
      if (vSnap.method && safeBrandKey(vSnap.method) !== brandKey) { await releaseSub(); return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: `❌ এই বোনাস কোডটি [${vSnap.method}]-এর জন্য তৈরি!` }); }
      const vAmt = parseFloat(vSnap.amount) || 0;
      if (vAmt > 0 && Math.abs(vAmt - expAmt) > 0.01) { await releaseSub(); return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: `❌ টাকার অঙ্ক মেলেনি (কোড: ৳${vAmt}, ইনভয়েস: ৳${expAmt})!` }); }

      const vLock = await rtdbAtomicTransaction(`bonus_vouchers/${matchedVKey}`, c => (!c || c.used === true || c.status === "CLAIMED") ? undefined : { ...c, used: true, status: "CLAIMED", claimed_by: invoice_id, claimed_at: Date.now() });
      if (!vLock.committed) { await releaseSub(); return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "❌ এই বোনাস কোডটি ইতিমধ্যে ব্যবহৃত!" }); }

      const r = await executeFulfillment(invoice_id, cleanTrx, expAmt, vSnap.method || method, null, true);
      if (!r.ok) { await releaseSub(); return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: r.reason }); }
      return res.json({ status: true, paymentStatus: "SUCCESS", title: "Payment Successful!", message: "Your balance has been added successfully.", trxId: cleanTrx, amount: expAmt, method: vSnap.method || method, invoiceId: invoice_id, updatedBalance: r.updatedBalance, verifiedAt: r.verifiedAt, redirect_url: r.redirectUrl });
    }

    const autoCfg = await fbGet(`${RTDB_URL}/settings/auto_verify.json`);
    if (!autoCfg || autoCfg.enabled !== false) {
      const tol = (autoCfg && autoCfg.tolerance !== undefined) ? Number(autoCfg.tolerance) : 0;
      const smsData = await fbGet(`${RTDB_URL}/sms_pool.json?orderBy=%22%24key%22&limitToLast=250`);
      const m = findMatchingSmsInPool(smsData, cleanTrx, expAmt, brandKey, tol);
      if (m.success) {
        const r = await executeFulfillment(invoice_id, cleanTrx, m.amount, m.matchedBrand, m.key, false);
        if (!r.ok) { await releaseSub(); return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: r.reason }); }
        return res.json({ status: true, paymentStatus: "SUCCESS", title: "Payment Successful!", message: "Your balance has been added successfully.", trxId: cleanTrx, amount: m.amount, method: m.matchedBrand, invoiceId: invoice_id, updatedBalance: r.updatedBalance, verifiedAt: r.verifiedAt, redirect_url: r.redirectUrl });
      }
      if (m.mismatch) {
        await releaseSub();
        return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: m.error });
      }
    }

    await fbJson(`${RTDB_URL}/invoices/${invoice_id}.json`, "PATCH", { trx_id: cleanTrx, method: brandKey, submittedAt: Date.now() });
    return res.json({ status: false, paymentStatus: "PENDING", title: "Payment Under Verification", message: "Your payment is being verified. Please wait for confirmation.", invoiceId: invoice_id, trxId: cleanTrx });
  } catch {
    return res.json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "Your transaction could not be verified. Please check your Transaction ID and try again." });
  }
});

// 5. LUXURY VIP CHECKOUT PAGE (/checkout) - COMPACT OFFICIAL LOGOS
app.get("/checkout", async (req, res) => {
  const qInvId = sanitizeText(req.query.invoice_id);
  const inv = qInvId ? await fbGet(`${RTDB_URL}/invoices/${qInvId}.json`) : null;
  if (qInvId && !inv) return res.status(404).send("<div style='font-family:sans-serif;text-align:center;margin-top:60px'><h2>❌ ইনভয়েস পাওয়া যায়নি</h2></div>");

  const invoice_id = inv ? qInvId : "", displayInv = qInvId || ("#TPP" + Date.now().toString().slice(-10));
  const st = inv ? String(inv.status || "PENDING").toUpperCase() : "PENDING";
  const isPaid = ["PAID","APPROVED","COMPLETED","SUCCESS"].includes(st);
  const amt = Math.max(1, Math.min(100000, parseFloat(inv ? inv.amount : (req.query.amount || 500)) || 500));
  const redirectUrl = sanitizeSafeUrl(inv?.redirect_url || req.query.redirect_url);
  const details = cleanOrderDetails(inv?.order_details);
  const isDirect = String(inv?.order_type || "").toUpperCase().includes("ORDER") || !!(details && (details.gameName || details.productName));
  const userId = inv?.userId || sanitizeText(req.query.uid || "");
  const pin = "PIN-" + displayInv.slice(-4);
  const remSec = inv?.expiresAt ? Math.max(0, Math.floor((inv.expiresAt - Date.now()) / 1000)) : 899;

  let curBal = 0;
  if (userId) { const u = await fbGet(`${FS_BASE}/users/${userId}?key=${API_KEY}`); if (u?.fields?.balance) curBal = fsNumVal(u.fields.balance); }
  const afterBal = curBal + amt;

  const [gSnap, numSnap, noticeSnap] = await Promise.all([
    fbGet(`${RTDB_URL}/settings/gateways.json`), fbGet(`${RTDB_URL}/settings/numbers.json`), fbGet(`${RTDB_URL}/settings/notice.json`)
  ]);

  const svg = k => ({
    bkash: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 95"><polygon points="48,8 98,18 78,55" fill="#E2136E"/><polygon points="48,8 78,55 28,45" fill="#C41160"/><polygon points="78,55 98,18 90,82" fill="#E2136E"/><polygon points="28,45 78,55 48,92" fill="#EC428F"/><polygon points="8,40 28,45 14,75" fill="#9B0D4C"/><polygon points="48,8 28,45 8,40" fill="#E2136E"/></svg>'),
    nagad: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#FFF7ED"/><path d="M50 12 C30 28,22 50,36 69 C46 82,68 82,77 68 C86 55,76 37,63 32 C50 28,46 42,55 50 C60 54,68 50,66 43" fill="none" stroke="#F97316" stroke-width="9" stroke-linecap="round"/><circle cx="50" cy="50" r="7" fill="#EA580C"/></svg>'),
    rocket: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="6" y="6" width="88" height="88" rx="22" fill="#8C30F5"/><path d="M26 72 L38 66 L44 78 Z" fill="#FFF"/><path d="M36 64 L66 34 L76 44 L46 74 Z" fill="#FFF"/><circle cx="58" cy="46" r="5" fill="#8C30F5"/></svg>'),
    upay: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="6" y="6" width="88" height="88" rx="22" fill="#FDE047"/><path d="M30 30 V58 C30 70,70 70,70 58 V30" fill="none" stroke="#005596" stroke-width="13" stroke-linecap="round"/><circle cx="50" cy="28" r="7" fill="#0081C6"/></svg>'),
    binance: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="6" y="6" width="88" height="88" rx="22" fill="#0B0E11"/><polygon points="50,18 64,32 50,46 36,32" fill="#F3BA2F"/><polygon points="22,46 32,36 42,46 32,56" fill="#F3BA2F"/><polygon points="78,46 68,36 58,46 68,56" fill="#F3BA2F"/><polygon points="50,54 64,68 50,82 36,68" fill="#F3BA2F"/><polygon points="50,41 59,50 50,59 41,50" fill="#F3BA2F"/></svg>'),
    premium: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1E1B4B"/><stop offset="100%" stop-color="#090B10"/></linearGradient><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FEF08A"/><stop offset="100%" stop-color="#D97706"/></linearGradient></defs><rect x="4" y="4" width="92" height="92" rx="24" fill="url(#pg)" stroke="#F59E0B" stroke-width="3"/><path d="M22 66 L28 34 L42 50 L50 24 L58 50 L72 34 L78 66 Z" fill="url(#cg)"/><rect x="22" y="71" width="56" height="8" rx="4" fill="#F59E0B"/></svg>')
  })[k];

  const meta = [
    { key:"bkash", name:"bKash", file:"https://murubbipay.com/wallets/bkash.png", color:"#E2136E", ussd:"*247#", dial:"tel:*247%23", hint:"৮-১৪ অক্ষর (যেমন: BLG789ABCD)", def:"01825760029", min:10, max:25000, desc:"বিকাশ অ্যাপ ওপেন করে সেন্ড মানি করুন এবং TrxID বসান" },
    { key:"nagad", name:"Nagad", file:"https://murubbipay.com/wallets/nagad.png", color:"#F97316", ussd:"*167#", dial:"tel:*167%23", hint:"৭-১৪ অক্ষর (যেমন: 7K89ABCD)", def:"01825760029", min:10, max:25000, desc:"নগদ অ্যাপ থেকে সেন্ড মানি করুন এবং প্রাপ্ত TxnID দিন" },
    { key:"rocket", name:"Rocket", file:"https://murubbipay.com/wallets/rocket.png", color:"#8C30F5", ussd:"*322#", dial:"tel:*322%23", hint:"৮-১৮ ডিজিট (যেমন: 3876543210)", def:"01965101494", min:10, max:25000, desc:"Rocket App বা *322# ডায়াল করে সেন্ড মানি করুন" },
    { key:"upay", name:"Upay", file:"https://murubbipay.com/wallets/upay.png", color:"#0081C6", ussd:"*268#", dial:"tel:*268%23", hint:"৭-২০ অক্ষর (যেমন: UP89AB12CD)", def:"01825760029", min:10, max:25000, desc:"Upay অ্যাপ থেকে সেন্ড মানি করে TxnID দিন" },
    { key:"binance", name:"Binance Pay", file:"https://cdn.simpleicons.org/binance/F0B90B", color:"#D97706", ussd:"Pay ID", dial:"", hint:"Order/Pay ID (কমপক্ষে ৬ অক্ষর)", def:"Binance Pay ID", min:1, max:5000, desc:"Binance Pay থেকে পেমেন্ট সম্পন্ন করে Order ID দিন" },
    { key:"premium", name:"Premium", file:svg("premium"), color:"#D97706", ussd:"VIP Wallet", dial:"", hint:"Transaction ID (কমপক্ষে ৬ অক্ষর)", def:"Premium Wallet", min:50, max:50000, desc:"Premium Wallet-এ পেমেন্ট সম্পন্ন করে Transaction ID দিন" }
  ];

  const gwCfg = {};
  meta.forEach(m => {
    const g = (gSnap && gSnap[m.key]) || {};
    const poolArr = g.numbers ? (Array.isArray(g.numbers) ? g.numbers : Object.values(g.numbers)).filter(n => n?.active && n.number) : [];
    const primary = g.number || poolArr[0]?.number || numSnap?.[m.key] || m.def;
    const pool = [{ number: primary, type: g.type || "Send Money", desc: g.desc || m.desc }];
    poolArr.forEach(p => { if (p.number !== primary) pool.push({ number: p.number, type: p.type || g.type || "Send Money", desc: p.desc || g.desc || m.desc }); });
    const adminCustomLogo = (g.logo_img && /^https?:\/\//i.test(String(g.logo_img).trim())) ? String(g.logo_img).trim() : "";
    gwCfg[m.key] = {
      key: m.key, name: m.name, color: m.color, ussd: m.ussd, dial: m.dial, hint: m.hint,
      enabled: g.enabled !== false, number: primary, pool, type: g.type || "Send Money",
      logo: adminCustomLogo || m.file, fallbackLogo: svg(m.key),
      type_img: g.type_img || g.qr_image || "",
      min_amount: Number(g.min_amount ?? m.min), max_amount: Number(g.max_amount ?? m.max), desc: g.desc || m.desc
    };
  });

  const enabled = meta.filter(m => gwCfg[m.key].enabled), first = enabled[0]?.key || "bkash";
  const notice = (noticeSnap && noticeSnap.active !== false && noticeSnap.text) ? String(noticeSnap.text) : "";
  const gName = escapeHtml(details?.gameName || "Game Order"), pName = detailsSafe((details && (details.product?.name || details.productName || details.product)) || "Diamond Package"), pId = escapeHtml(details?.playerId || "N/A");
  const gwJson = JSON.stringify(gwCfg).replace(/</g, "\\u003c");

  res.send(`<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><title>Instant VIP Checkout &bull; TOPUPPRO</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800;900&family=Hind+Siliguri:wght@500;600;700;800&family=JetBrains+Mono:wght@600;700;800;900&display=swap" rel="stylesheet">
<style>
:root{--accent:#E2136E;--gold:#f59e0b;--gold-grad:linear-gradient(135deg,#fef08a 0%,#facc15 40%,#f59e0b 90%);--brand:#4f46e5;--emerald:#10b981;--danger:#ef4444;--muted:#64748b;--border:#e2e8f0}
*{box-sizing:border-box;margin:0;padding:0;font-family:'Plus Jakarta Sans','Hind Siliguri',sans-serif;-webkit-tap-highlight-color:transparent}
body{min-height:100vh;background:radial-gradient(circle at 50% -10%,#1e1354 0%,#0b0f28 50%,#020617 100%);color:#0f172a;display:flex;flex-direction:column;align-items:center;padding:12px 10px 45px;overflow-x:hidden}
@keyframes pulseLive{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.35;transform:scale(1.35)}}
@keyframes radarRing{0%{transform:scale(0.8);opacity:1}100%{transform:scale(1.6);opacity:0}}
@keyframes floatCoin{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}

.top-nav{width:100%;max-width:960px;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:rgba(255,255,255,0.97);border:1.5px solid rgba(245,158,11,0.5);border-radius:20px;margin-bottom:12px;box-shadow:0 16px 40px rgba(0,0,0,0.28);gap:8px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:#0f172a}
.brand-ic{width:40px;height:40px;background:linear-gradient(135deg,#090b10,#f59e0b);color:#fde047;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;box-shadow:0 4px 14px rgba(245,158,11,0.35)}
.nav-r{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.live-pill{display:flex;align-items:center;gap:5px;background:#ecfdf5;border:1px solid #a7f3d0;color:#059669;padding:5px 10px;border-radius:99px;font-size:10.5px;font-weight:800}
.live-dot{width:7px;height:7px;border-radius:50%;background:#10b981;animation:pulseLive 1.4s infinite}
.btn-snd{background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:5px 10px;border-radius:99px;font-size:11px;font-weight:800;cursor:pointer}
.btn-snd.on{background:#090b10;border-color:#090b10;color:#fde047}
.user-pill{background:#eef2ff;border:1.5px solid #c7d2fe;color:var(--brand);padding:6px 13px;border-radius:12px;font-family:'JetBrains Mono';font-size:12.5px;font-weight:900;cursor:pointer}

.notice{width:100%;max-width:960px;background:#fffbeb;border:1.5px solid #f59e0b;color:#92400e;border-radius:14px;padding:9px 14px;font-size:12px;font-weight:800;margin-bottom:12px}
.master-box{width:100%;max-width:960px;background:#fff;border-radius:26px;padding:20px 16px;box-shadow:0 22px 60px rgba(0,0,0,0.38);border-top:5px solid var(--accent);margin-bottom:16px;transition:0.25s}
@media(min-width:768px){.master-box{padding:26px 24px}}

.stepper{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:15px;background:#f8fafc;border:1px solid var(--border);border-radius:14px;padding:5px}
.step-tab{text-align:center;font-size:11px;font-weight:800;color:var(--muted);padding:6px 4px;border-radius:10px}
.step-tab.active{background:#090b10;color:#fde047}.step-tab.done{background:#ecfdf5;color:#059669}

.head-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.head-title{display:flex;align-items:center;gap:10px}
.wallet-ic{width:42px;height:42px;border-radius:14px;background:#e0e7ff;display:flex;align-items:center;justify-content:center;font-size:21px}
.badge-enc{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;padding:5px 13px;border-radius:99px;font-size:11px;font-weight:800}

/* COMPACT PREMIUM METHOD CARDS (ORIGINAL SLEEK SIZE) */
.methods{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-bottom:16px}
@media(min-width:600px){.methods{grid-template-columns:repeat(3,1fr)}}@media(min-width:900px){.methods{grid-template-columns:repeat(6,1fr)}}
.m-card{background:#fff;border:1.5px solid var(--border);border-radius:16px;padding:11px 6px;text-align:center;cursor:pointer;position:relative;transition:0.2s}
.m-card:hover{transform:translateY(-2px);border-color:#cbd5e1;box-shadow:0 6px 16px rgba(15,23,42,0.06)}
.m-card.active{border:2px solid var(--accent);background:#f8faff;box-shadow:0 6px 18px rgba(37,99,235,0.13)}
.chk{position:absolute;top:6px;right:6px;width:17px;height:17px;border-radius:50%;background:var(--accent);color:#fff;font-size:9.5px;display:none;align-items:center;justify-content:center;font-weight:900}
.m-card.active .chk{display:flex}
.m-logo{height:32px;display:flex;align-items:center;justify-content:center;margin-bottom:4px}
.m-logo img{height:26px;width:auto;max-width:56px;object-fit:contain;display:block}

.split{display:grid;grid-template-columns:1fr;gap:15px}@media(min-width:768px){.split{grid-template-columns:1.15fr 1fr}}
.subcard{background:#f8fafc;border:1.5px solid var(--border);border-radius:20px;padding:15px}
.det-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.det-brand{display:flex;align-items:center;gap:8px}
.det-logo{width:34px;height:24px;object-fit:contain;background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:2px 3px}
.det-badge{font-size:10px;font-weight:800;color:#059669;background:#ecfdf5;border:1px solid #a7f3d0;padding:2px 8px;border-radius:99px;white-space:nowrap}

.num-box{background:#fff;border:1.5px dashed var(--accent);border-radius:14px;padding:12px 13px;display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:11px}
.btn-sm{background:var(--accent);color:#fff;border:none;padding:8px 12px;border-radius:10px;font-size:11px;font-weight:800;cursor:pointer;text-decoration:none;white-space:nowrap;transition:0.15s}
.btn-sm:active{transform:scale(0.96)}
.btn-dial{background:#090b10;color:#fde047}.btn-rot{background:#eef2ff;color:#4f46e5;border:1px solid #c7d2fe;padding:4px 8px;border-radius:8px;font-size:10px;font-weight:800;cursor:pointer;margin-top:4px;display:none}
.banner{width:100%;height:128px;border-radius:14px;overflow:hidden;margin-bottom:11px;border:1px solid #cbd5e1}.banner img{width:100%;height:100%;object-fit:cover}
.guide{background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:12px}
.step-row{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:700;color:#334155;margin-bottom:6px}
.step-row:last-child{margin-bottom:0}
.step-c{width:20px;height:20px;border-radius:50%;background:var(--accent);color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:900}

.trx-lbl-wrap{display:flex;align-items:center;gap:6px}
.trx-mini-logo{width:26px;height:18px;object-fit:contain;background:#fff;border:1px solid #e2e8f0;border-radius:5px;padding:1px 2px}
.trx-in{width:100%;background:#fff;border:2px solid #cbd5e1;border-radius:14px;padding:12px 14px;font-family:'JetBrains Mono';font-size:15px;font-weight:900;text-transform:uppercase;outline:none}
.trx-in:focus{border-color:var(--accent);box-shadow:0 0 12px rgba(79,70,229,0.16)}
.stmt{background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:11px 13px;margin:10px 0;font-size:11.5px}
.s-row{display:flex;justify-content:space-between;padding:3px 0}.s-row span{color:var(--muted);font-weight:700}
.meta-s{display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#fff;border:1px solid var(--border);border-radius:14px;padding:9px;margin-bottom:12px;text-align:center}
.btn-go{width:100%;border:none;border-radius:15px;padding:15px;background:linear-gradient(90deg,#4f46e5 0%,#06b6d4 100%);color:#fff;font-size:15px;font-weight:900;cursor:pointer;box-shadow:0 8px 22px rgba(79,70,229,0.34)}
.btn-go:disabled{opacity:0.6;cursor:not-allowed}

.sup-box{width:100%;max-width:960px;background:#fff;border:1.5px solid var(--border);border-radius:24px;padding:20px;display:grid;grid-template-columns:1fr;gap:14px;align-items:center;box-shadow:0 18px 45px rgba(0,0,0,0.22)}
@media(min-width:768px){.sup-box{grid-template-columns:1.5fr 1fr}}
.perks{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:10px;font-size:11.5px;font-weight:800;color:#334155}
.mock{height:105px;display:flex;align-items:center;justify-content:center;position:relative}
.ph{width:82px;height:104px;background:#090b10;border:2.5px solid var(--brand);border-radius:16px;display:flex;align-items:center;justify-content:center}
.ph-ok{width:34px;height:34px;border-radius:50%;background:#10b981;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900}
.coin{position:absolute;font-size:18px;animation:floatCoin 2.6s infinite ease-in-out}
.foot{width:100%;max-width:960px;display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding:8px 6px;font-size:11.5px;color:#94a3b8;flex-wrap:wrap;gap:10px}
.foot a{color:#818cf8;text-decoration:none;font-weight:700;margin-left:12px}

.modal-bg{position:fixed;inset:0;background:rgba(15,23,42,0.8);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:14px;z-index:99999}
.m-card-box{background:#fff;color:#0f172a;border-radius:26px;width:100%;max-width:430px;padding:22px 18px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.4)}
.radar{width:66px;height:66px;border-radius:50%;background:#e0e7ff;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;position:relative;font-size:28px}
.ring{position:absolute;inset:0;border-radius:50%;border:2px solid var(--brand);animation:radarRing 1.2s infinite ease-out}
.prog{width:100%;height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:10px 0}.prog-b{height:100%;width:0%;background:linear-gradient(90deg,#4f46e5,#06b6d4);transition:width 0.9s linear}
.rec{background:#f8fafc;border:1.5px solid var(--border);border-radius:14px;padding:11px;margin:12px 0;text-align:left;font-size:12px}
.r-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px dashed #cbd5e1}.r-row:last-child{border-bottom:none}
.r-meth-wrap{display:inline-flex;align-items:center;gap:5px}
.r-meth-logo{width:24px;height:17px;object-fit:contain;background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:1px 2px}
.trouble{background:#fff1f2;border:1px dashed #f43f5e;border-radius:13px;padding:10px;margin:10px 0;text-align:left;font-size:11px;color:#9f1239;line-height:1.55}
.toast-msg{position:fixed;top:18px;left:50%;transform:translateX(-50%) translateY(-80px);background:#0f172a;color:#fff;padding:9px 16px;border-radius:99px;font-size:12px;font-weight:800;z-index:999999;box-shadow:0 10px 25px rgba(0,0,0,0.3);transition:transform 0.25s ease,opacity 0.25s ease;opacity:0;pointer-events:none}
.toast-msg.show{transform:translateX(-50%) translateY(0);opacity:1}
@media print{.top-nav,.notice,.master-box,.sup-box,.foot,.no-print,.toast-msg{display:none!important}.modal-bg{position:static;background:#fff;display:flex!important}}
</style></head><body>
<div id="toastMsg" class="toast-msg">✓ কপি হয়েছে</div>
<div class="top-nav">
  <a href="${escapeHtml(redirectUrl)}" class="brand"><div class="brand-ic">TP</div><div><b style="font-size:16px">TOPUPPRO</b><span style="display:block;font-size:9.5px;color:var(--muted);font-weight:700">Enterprise Payment Gateway</span></div></a>
  <div class="nav-r">
    <div class="live-pill"><div class="live-dot"></div><span>LIVE</span></div>
    <button type="button" class="btn-snd on" id="btnSoundMode" onclick="toggleSound()">🔊 সাউন্ড: অন</button>
    <div class="user-pill" onclick="copyText('${amt}','টাকার পরিমাণ')" title="ক্লিক করে কপি করুন">👤 Customer &bull; ৳ ${amt.toFixed(2)}</div>
  </div>
</div>
${notice ? `<div class="notice">🔔 ${escapeHtml(notice)}</div>` : ""}
<div class="master-box">
  <div class="stepper"><div class="step-tab active" id="st1">① মেথড</div><div class="step-tab" id="st2">② পেমেন্ট ও TrxID</div><div class="step-tab" id="st3">③ অটো ভেরিফাই</div></div>
  <div class="head-bar">
    <div class="head-title"><div class="wallet-ic">💳</div><div><h3 style="font-size:17.5px;font-weight:900">Secure Checkout</h3><p style="font-size:11px;color:var(--muted)">Select Payment Method and Submit Transaction ID</p></div></div>
    <div class="badge-enc">🛡️ 100% Encrypted &amp; Safe</div>
  </div>
  <div class="methods">${enabled.map(m => `<div class="m-card ${m.key===first?"active":""}" id="card_${m.key}" onclick="selectMethod('${m.key}')"><div class="chk">✓</div><div class="m-logo"><img src="${escapeHtml(gwCfg[m.key].logo)}" onerror="this.onerror=null;this.src='${escapeHtml(gwCfg[m.key].fallbackLogo)}'" alt="${escapeHtml(m.name)}"></div><b style="font-size:12.5px;color:${m.color}">${escapeHtml(m.name)}</b><span style="display:block;font-size:9.5px;color:var(--muted);font-weight:700">Min ৳${gwCfg[m.key].min_amount}</span></div>`).join("")}</div>
  <div class="split">
    <div class="subcard">
      <div class="det-head">
        <div class="det-brand">
          <img id="detLogo" class="det-logo" src="${escapeHtml(gwCfg[first].logo)}" onerror="this.onerror=null;this.src='${escapeHtml(gwCfg[first].fallbackLogo)}'" alt="Method">
          <b style="font-size:14px" id="detTitle">${escapeHtml(gwCfg[first].name)} Payment Details</b>
        </div>
        <span class="det-badge">✓ Selected</span>
      </div>
      <div class="num-box">
        <div><span id="numMode" style="font-size:10px;color:var(--muted);font-weight:800;display:block">Send Money</span><b id="actNum" style="font-family:'JetBrains Mono';font-size:16.5px">---</b><button type="button" class="btn-rot" id="btnRot" onclick="rotateNum()">🔄 অন্য নম্বর</button></div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end"><a id="btnDial" class="btn-sm btn-dial" href="#">📞 ডায়াল</a><button type="button" class="btn-sm" onclick="copyText(document.getElementById('actNum').innerText,'পেমেন্ট নম্বর',this)">📋 Copy</button></div>
      </div>
      <div class="banner"><img id="banImg" src="" alt="Payment Instruction Banner"></div>
      <div class="guide">
        <b style="color:var(--brand);font-size:11.5px;display:block;margin-bottom:7px">Payment Instructions:</b>
        <div class="step-row"><div class="step-c">1</div><span id="s1">Open Payment App</span> (<b id="ussdTxt">*247#</b>)</div>
        <div class="step-row"><div class="step-c">2</div><span>Send <b style="color:var(--emerald)">৳${amt}</b> to <b id="s2">---</b></span></div>
        <div class="step-row"><div class="step-c">3</div><span id="s3">Enter Transaction ID and Submit</span></div>
      </div>
    </div>
    <div class="subcard">
      <b style="font-size:14px;display:block;margin-bottom:8px">✏️ Enter Transaction ID</b>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div class="trx-lbl-wrap">
          <img id="trxMethodLogo" class="trx-mini-logo" src="${escapeHtml(gwCfg[first].logo)}" onerror="this.onerror=null;this.src='${escapeHtml(gwCfg[first].fallbackLogo)}'" alt="Method">
          <b id="trxLbl" style="font-size:12px;color:var(--brand)">TrxID দিন:</b>
        </div>
        <button type="button" onclick="pasteTrx()" style="background:#eef2ff;color:#4f46e5;border:1px solid #c7d2fe;padding:5px 11px;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer">📋 Paste</button>
      </div>
      <input type="text" id="trxIn" class="trx-in" placeholder="Transaction ID লিখুন..." autocomplete="off" spellcheck="false" oninput="onTrxType(this)">
      <div id="trxHint" style="font-size:10.5px;color:var(--muted);font-weight:700;margin-top:4px"></div>
      <div class="stmt">
        <div style="display:flex;justify-content:space-between;font-weight:900;color:var(--brand);border-bottom:1px dashed var(--border);padding-bottom:5px;margin-bottom:6px"><span>📋 অ্যাকাউন্ট স্টেটমেন্ট ও সার্ভিস বিবরণ</span><span>${escapeHtml(pin)}</span></div>
        ${isDirect ? `<div class="s-row"><span>সার্ভিসের ধরন:</span><b style="color:#7c3aed">🎮 সরাসরি গেমিং অর্ডার</b></div><div class="s-row"><span>গেমের নাম:</span><b>${gName}</b></div><div class="s-row"><span>প্যাকেজ:</span><b style="color:var(--emerald)">${pName}</b></div><div class="s-row"><span>প্লেয়ার আইডি (UID):</span><b style="color:#0284c7">${pId}</b></div><div class="s-row"><span>ওয়ালেট ব্যালেন্স:</span><b>৳ ${curBal.toFixed(2)} (অপরিবর্তিত)</b></div>` : `<div class="s-row"><span>সার্ভিসের ধরন:</span><b style="color:var(--emerald)">💳 ওয়ালেট ব্যালেন্স রিচার্জ</b></div><div class="s-row"><span>পূর্বের ব্যালেন্স (Before):</span><b>৳ ${curBal.toFixed(2)}</b></div><div class="s-row"><span>যোগ হচ্ছে (Adding):</span><b style="color:var(--brand)">+ ৳ ${amt.toFixed(2)}</b></div><div class="s-row"><span>পরবর্তী মোট ব্যালেন্স (After):</span><b style="color:var(--emerald)">৳ ${afterBal.toFixed(2)}</b></div>`}
      </div>
      <div class="meta-s"><div><span style="font-size:10px;color:var(--muted);display:block">Time Left</span><b id="tClock" style="font-family:'JetBrains Mono';color:var(--danger)">14:59</b></div><div><span style="font-size:10px;color:var(--muted);display:block">Invoice ID</span><b style="font-family:'JetBrains Mono';color:var(--brand)">${escapeHtml(displayInv)}</b></div></div>
      <button type="button" class="btn-go" id="btnSub" onclick="submitPayment()">✈️ Submit Payment ➔</button>
    </div>
  </div>
</div>

<div class="sup-box">
  <div><h2 style="font-size:18px;font-weight:900">24/7 Live Customer <span style="color:var(--brand)">Support</span></h2><p style="font-size:12px;color:var(--muted);margin-top:4px">পেমেন্ট সংক্রান্ত যেকোনো সহায়তায় আমাদের সাপোর্ট টিম সার্বক্ষণিক প্রস্তুত।</p><div class="perks"><div>⚡ Instant Automated Verification</div><div>🔒 Bank Level Encryption</div><div>🎧 WhatsApp &amp; Telegram Support</div><div>🛡️ 100% Anti-Fraud Protection</div></div></div>
  <div class="mock"><div class="coin" style="top:6px;left:22%">🪙</div><div class="coin" style="bottom:8px;right:22%">🪙</div><div class="ph"><div class="ph-ok">✓</div></div></div>
</div>
<div class="foot"><div>&copy; 2026 TOPUPPRO. Fast &bull; Secure &bull; Reliable.</div><div><a href="${escapeHtml(redirectUrl)}">About Us</a><a href="${escapeHtml(redirectUrl)}">Privacy Policy</a><a href="${escapeHtml(redirectUrl)}">Terms</a><a href="${escapeHtml(redirectUrl)}">Contact</a></div></div>

<div class="modal-bg" id="vModal"><div class="m-card-box" style="border:2px solid var(--brand)"><div class="radar"><div class="ring"></div>⚡</div><h3 style="font-weight:900">যাচাই করা হচ্ছে...</h3><div style="font-family:'JetBrains Mono';font-size:28px;font-weight:900;color:var(--brand);margin:4px 0"><span id="vSec">10</span>s</div><div class="prog"><div class="prog-b" id="vProg"></div></div><div id="vLog" style="font-size:12px;color:var(--muted);font-weight:700">ডাটাবেজে TrxID ও SMS হিস্ট্রি স্ক্যান করা হচ্ছে...</div></div></div>
<div class="modal-bg" id="pModal"><div class="m-card-box" style="border:2px solid var(--gold)"><div style="font-size:42px">⏳</div><h3 style="font-weight:900;margin-top:4px">Payment Under Verification</h3><p style="font-size:12px;color:var(--muted);margin-top:4px">আপনার পেমেন্ট অটো-যাচাই চলছে। অনুগ্রহ করে অপেক্ষা করুন।</p><div class="rec"><div class="r-row"><span>ইনভয়েস আইডি:</span><b>${escapeHtml(displayInv)}</b></div><div class="r-row"><span>প্রদত্ত TrxID:</span><b id="pTrx">---</b></div><div class="r-row"><span>স্ট্যাটাস:</span><b style="color:#d97706">PENDING (Auto Checking...)</b></div></div><button type="button" class="btn-go" onclick="document.getElementById('pModal').style.display='none'">ঠিক আছে &bull; অপেক্ষা করুন</button></div></div>
<div class="modal-bg" id="sModal"><div class="m-card-box" style="border:2px solid var(--emerald)"><div style="width:60px;height:60px;border-radius:50%;background:#dcfce7;color:#059669;display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 10px">✓</div><h2 style="font-weight:900">Payment Successful!</h2><p style="font-size:12px;color:var(--muted)">${isDirect ? "আপনার গেম অর্ডারটি প্রসেসিং শুরু হয়েছে।" : "Your balance has been added successfully."}</p><div class="rec"><div class="r-row"><span>Transaction ID:</span><b id="rTrx" style="color:#0284c7">${escapeHtml(inv?.trx_id || "VERIFIED")}</b></div><div class="r-row"><span>Payment Amount:</span><b style="color:var(--emerald)">৳ ${amt.toFixed(2)}</b></div><div class="r-row"><span>Payment Method:</span><span class="r-meth-wrap"><img id="rLogo" class="r-meth-logo" src="${escapeHtml(gwCfg[safeBrandKey(inv?.method || first)].logo)}" onerror="this.style.display='none'"><b id="rMeth">${escapeHtml(inv?.method || first).toUpperCase()}</b></span></div><div class="r-row"><span>Invoice ID:</span><b>${escapeHtml(displayInv)}</b></div>${!isDirect ? `<div class="r-row"><span>Updated Balance:</span><b id="rBal" style="color:var(--emerald)">৳ ${curBal.toFixed(2)}</b></div>` : `<div class="r-row"><span>প্লেয়ার আইডি:</span><b>${pId}</b></div>`}<div class="r-row"><span>Success Time:</span><b id="rTime">${inv?.paidAt ? new Date(inv.paidAt).toLocaleString("bn-BD") : "---"}</b></div></div><div class="no-print" style="display:flex;gap:8px"><button type="button" class="btn-go" style="background:#f1f5f9;color:#0f172a;flex:0.45" onclick="window.print()">🖨️ রিসিট</button><button type="button" class="btn-go" style="background:linear-gradient(135deg,#10b981,#059669);flex:1" onclick="location.href=redir">ড্যাশবোর্ডে যান ➔</button></div></div></div>
<div class="modal-bg" id="fModal"><div class="m-card-box" style="border:2px solid var(--danger)"><div style="width:60px;height:60px;border-radius:50%;background:#fee2e2;color:#dc2626;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 10px">✕</div><h3 style="font-weight:900">Payment Failed!</h3><p id="fReason" style="font-size:12px;color:#dc2626;font-weight:800;margin:6px 0">Your transaction could not be verified.</p><div class="trouble"><b>⚠️ যেভাবে সমাধান করবেন:</b><br>১. আপনি যে মাধ্যমে টাকা পাঠিয়েছেন ঠিক সেই মাধ্যমটি সিলেক্ট করুন।<br>২. আপনার ফিরতি ব্যাংক SMS থেকে Transaction ID হুবহু মিলিয়ে বসান।<br>৩. একই TrxID দুইবার ব্যবহার করা যাবে না।</div><div class="rec"><div class="r-row"><span>প্রদত্ত TrxID:</span><b id="fTrx" style="color:#dc2626">---</b></div><div class="r-row"><span>মেথড:</span><span class="r-meth-wrap"><img id="fLogo" class="r-meth-logo" src="${escapeHtml(gwCfg[first].logo)}" onerror="this.style.display='none'"><b id="fMeth">---</b></span></div><div class="r-row"><span>প্রত্যাশিত পরিমাণ:</span><b>৳ ${amt.toFixed(2)}</b></div></div><button type="button" class="btn-go" style="background:linear-gradient(135deg,#ef4444,#dc2626)" onclick="closeFail()">পুনরায় সঠিক TrxID দিন 🔄</button></div></div>

<script>
const invId="${escapeHtml(invoice_id)}",invAmt=${amt},gw=${gwJson};
let paid=${isPaid?"true":"false"},redir="${escapeHtml(redirectUrl)}",curBrand="${escapeHtml(first)}",pIdx=0,busy=false,shown=false,pTimer=null,tLeft=${remSec},sndOn=true,actx=null,audUnlocked=false,toastTimer=null;

function showToast(msg){
  var el=document.getElementById("toastMsg");if(!el)return;
  el.innerText=msg;el.classList.add("show");
  clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.classList.remove("show");},1800);
}
function setImgWithFallback(id,src,fallback){
  var el=document.getElementById(id);if(!el)return;
  el.style.display="";
  el.onerror=function(){this.onerror=null;if(fallback)this.src=fallback;else this.style.display="none";};
  el.src=src||fallback||"";
}
function brandKeyClient(m){
  var s=String(m||curBrand||"bkash").toLowerCase();
  if(s.indexOf("nagad")!==-1)return "nagad";
  if(s.indexOf("rocket")!==-1)return "rocket";
  if(s.indexOf("upay")!==-1)return "upay";
  if(s.indexOf("binance")!==-1)return "binance";
  if(s.indexOf("premium")!==-1)return "premium";
  return "bkash";
}

function unlockAudio(){audUnlocked=true;try{if(!actx)actx=new(window.AudioContext||window.webkitAudioContext)();if(actx.state==="suspended")actx.resume();}catch(e){}}
document.addEventListener("pointerdown",unlockAudio,{once:true});
function beep(freqs,type,dur,vol){
  if(!sndOn)return;unlockAudio();
  try{var now=actx.currentTime;freqs.forEach(function(f,i){var o=actx.createOscillator(),g=actx.createGain();o.type=type||"sine";o.frequency.setValueAtTime(f,now+i*0.07);g.gain.setValueAtTime(vol||0.13,now+i*0.07);g.gain.exponentialRampToValueAtTime(0.0001,now+i*0.07+(dur||0.18));o.connect(g);g.connect(actx.destination);o.start(now+i*0.07);o.stop(now+i*0.07+(dur||0.18));});}catch(e){}
}
function playClockTick(){
  if(!sndOn||!audUnlocked||busy)return;
  try{var now=actx.currentTime,o=actx.createOscillator(),g=actx.createGain();o.type="sine";o.frequency.setValueAtTime(1180,now);g.gain.setValueAtTime(0.032,now);g.gain.exponentialRampToValueAtTime(0.0001,now+0.035);o.connect(g);g.connect(actx.destination);o.start(now);o.stop(now+0.035);}catch(e){}
}
function playVerifyTick(sec){
  if(!sndOn)return;unlockAudio();
  try{var now=actx.currentTime,o=actx.createOscillator(),g=actx.createGain();o.type="triangle";o.frequency.setValueAtTime(840+(10-sec)*55,now);g.gain.setValueAtTime(0.15,now);g.gain.exponentialRampToValueAtTime(0.0001,now+0.09);o.connect(g);g.connect(actx.destination);o.start(now);o.stop(now+0.09);}catch(e){}
}
function toggleSound(){unlockAudio();sndOn=!sndOn;var b=document.getElementById("btnSoundMode");b.className=sndOn?"btn-snd on":"btn-snd";b.innerText=sndOn?"🔊 সাউন্ড: অন":"🔇 সাউন্ড: মিউট";if(sndOn)beep([784,1046],"sine",0.14,0.12);}
function setStep(n){for(var i=1;i<=3;i++){var e=document.getElementById("st"+i);e.className="step-tab"+(i<n?" done":(i===n?" active":""));}}
function svgBan(t,col){return "data:image/svg+xml;utf8,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="128" viewBox="0 0 360 128"><rect width="360" height="128" rx="14" fill="'+(col||"#4F46E5")+'"/><circle cx="310" cy="28" r="48" fill="rgba(255,255,255,0.12)"/><text x="20" y="42" font-family="sans-serif" font-size="10.5" font-weight="700" fill="rgba(255,255,255,0.88)">TOPUPPRO OFFICIAL PAYMENT</text><text x="20" y="78" font-family="sans-serif" font-size="24" font-weight="900" fill="#FFF">'+(t||"Send Money").toUpperCase()+'</text><text x="20" y="105" font-family="sans-serif" font-size="11.5" font-weight="600" fill="#E2E8F0">নিচের নির্দেশনা মেনে পেমেন্ট সম্পন্ন করুন</text></svg>');}
function applyNum(){
  var c=gw[curBrand]||{},pool=(c.pool&&c.pool.length)?c.pool:[{number:c.number,type:c.type,desc:c.desc}],cur=pool[pIdx%pool.length];
  document.getElementById("actNum").innerText=cur.number||"N/A";document.getElementById("s2").innerText=cur.number||"N/A";
  document.getElementById("numMode").innerText=(cur.type||"Send Money")+" (Min ৳"+c.min_amount+" - Max ৳"+c.max_amount+")";
  document.getElementById("s3").innerText=cur.desc||c.desc;document.getElementById("btnRot").style.display=pool.length>1?"inline-block":"none";
}
function rotateNum(){pIdx++;beep([660,880],"sine",0.1,0.1);applyNum();}
function selectMethod(b,silent){
  curBrand=b;pIdx=0;if(!silent)beep([520,760],"sine",0.1,0.1);
  var c=gw[b]||{};document.documentElement.style.setProperty("--accent",c.color||"#E2136E");
  document.querySelectorAll(".m-card").forEach(function(e){e.classList.remove("active");});
  document.getElementById("card_"+b)?.classList.add("active");
  document.getElementById("detTitle").innerText=(c.name||b)+" Payment Details";
  setImgWithFallback("detLogo",c.logo,c.fallbackLogo);
  setImgWithFallback("trxMethodLogo",c.logo,c.fallbackLogo);
  document.getElementById("s1").innerText="Open "+(c.name||b)+" App";
  document.getElementById("ussdTxt").innerText=c.ussd||"*247#";
  var dl=document.getElementById("btnDial");if(c.dial){dl.style.display="inline-block";dl.href=c.dial;}else{dl.style.display="none";}
  document.getElementById("banImg").src=c.type_img||svgBan(c.type,c.color);
  document.getElementById("trxLbl").innerText=(c.name||b)+" TrxID দিন:";
  document.getElementById("trxHint").innerText="ফরম্যাট: "+(c.hint||"TrxID");
  setStep(2);applyNum();
}
selectMethod(curBrand,true);
function copyText(t,lbl,btnEl){
  beep([620,930],"sine",0.12,0.12);
  var txt=String(t).trim();
  function done(){
    showToast("📋 "+lbl+" কপি হয়েছে: "+txt);
    if(btnEl){var old=btnEl.innerText;btnEl.innerText="✓ Copied!";setTimeout(function(){btnEl.innerText=old;},1800);}
  }
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(txt).then(done).catch(fallbackCopy);}
  else fallbackCopy();
  function fallbackCopy(){
    var ta=document.createElement("textarea");ta.value=txt;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.left="-9999px";
    document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,99999);
    try{document.execCommand("copy");done();}catch(e){prompt(lbl+" কপি করুন:",txt);}
    document.body.removeChild(ta);
  }
}
async function pasteTrx(){beep([700],"triangle",0.08,0.1);try{var v=(await navigator.clipboard.readText()).trim().toUpperCase();document.getElementById("trxIn").value=v;onTrxType(document.getElementById("trxIn"));showToast("✓ TrxID পেস্ট হয়েছে");}catch(e){var p=prompt("TrxID বা গিফট কোড লিখুন:");if(p){document.getElementById("trxIn").value=p.trim().toUpperCase();}}}
function onTrxType(el){el.value=el.value.toUpperCase();if(el.value.trim().length>=6)setStep(3);else setStep(2);}
setInterval(function(){if(tLeft<=0){document.getElementById("tClock").innerText="00:00";return;}tLeft--;playClockTick();var m=Math.floor(tLeft/60),s=tLeft%60;document.getElementById("tClock").innerText=(m<10?"0":"")+m+":"+(s<10?"0":"")+s;},1000);
function showOk(trx,m,bal,t){
  if(shown)return;shown=true;clearInterval(pTimer);setStep(3);
  document.getElementById("vModal").style.display="none";document.getElementById("pModal").style.display="none";
  var bk=brandKeyClient(m||curBrand),c=gw[bk]||{};
  setImgWithFallback("rLogo",c.logo,c.fallbackLogo);
  document.getElementById("rMeth").innerText=(m||c.name||curBrand).toUpperCase();document.getElementById("rTrx").innerText=trx;
  var be=document.getElementById("rBal");if(be&&bal!=null)be.innerText="৳ "+Number(bal).toFixed(2);
  document.getElementById("rTime").innerText=new Date(t||Date.now()).toLocaleString("bn-BD");
  beep([523.25,659.25,783.99,1046.5],"triangle",0.28,0.16);document.getElementById("sModal").style.display="flex";
}
function showFail(trx,msg){
  var c=gw[curBrand]||{};
  setImgWithFallback("fLogo",c.logo,c.fallbackLogo);
  document.getElementById("fTrx").innerText=trx;document.getElementById("fMeth").innerText=(c.name||curBrand).toUpperCase();
  document.getElementById("fReason").innerText=msg;beep([320,210],"sawtooth",0.2,0.14);document.getElementById("fModal").style.display="flex";
}
function closeFail(){beep([500],"sine",0.08,0.09);document.getElementById("fModal").style.display="none";document.getElementById("trxIn").focus();}
if(paid)document.getElementById("sModal").style.display="flex";
function startPoll(activeInv){
  clearInterval(pTimer);pTimer=setInterval(async function(){
    try{
      beep([880],"sine",0.06,0.04);
      var st=await fetch("/api/check-status?invoice_id="+encodeURIComponent(activeInv||invId)).then(function(r){return r.json();});
      if(st.status==="PAID"||st.paymentStatus==="SUCCESS"){paid=true;if(st.redirect_url)redir=st.redirect_url;showOk(st.trxId||"VERIFIED",st.method||curBrand,st.updatedBalance,st.paidAt);}
      else if(st.status==="REJECTED"||st.status==="EXPIRED"){clearInterval(pTimer);document.getElementById("pModal").style.display="none";showFail(st.trxId||"N/A","পেমেন্টটি "+st.status+" হয়েছে।");}
    }catch(e){}
  },3000);
}
async function submitPayment(){
  if(busy)return;
  if(paid||shown)return showFail("N/A","⚠️ এই ইনভয়েসের পেমেন্ট ইতিমধ্যে সফল হয়েছে! নতুন পেমেন্টের জন্য নতুন অর্ডার তৈরি করুন।");
  if(tLeft<=0)return showFail("EXPIRED","⏰ এই ইনভয়েসের সময় শেষ! নতুন অর্ডার তৈরি করুন।");
  var bn="০১২৩৪৫৬৭৮৯";
  var raw=document.getElementById("trxIn").value.replace(/[০-৯]/g,function(d){return bn.indexOf(d);}).trim().toUpperCase().replace(/^(?:TRXID|TXNID|TXN_ID|TRX_ID|TRX|TXN|ID|TRANS|TRANSACTION)[: #-]*/i,"");
  var trx=raw.replace(/[^A-Z0-9_-]/g,"");
  document.getElementById("trxIn").value=trx;
  if(!trx||trx.length<4)return showFail(raw||"খালি","দয়া করে সম্পূর্ণ ট্রানজ্যাকশন আইডি (TrxID) লিখুন!");
  var isBonus=(trx.indexOf("_")!==-1||trx.indexOf("GIFT")===0);
  if(!isBonus){
    if(curBrand==="bkash"&&!/^[A-Z0-9]{8,14}$/.test(trx))return showFail(trx,/^[0-9]+$/.test(trx)?"❌ এটি রকেটের নম্বর! বিকাশ TrxID দিন।":"❌ বিকাশ TrxID ৮-১৪ অক্ষরের (যেমন: BLG789ABCD) হতে হবে!");
    if(curBrand==="nagad"&&!/^[A-Z0-9]{7,14}$/.test(trx))return showFail(trx,"❌ নগদ TxnID ৭-১৪ অক্ষরের (যেমন: 7K89ABCD) হতে হবে!");
    if(curBrand==="rocket"&&!/^[A-Z0-9]{8,18}$/.test(trx))return showFail(trx,"❌ রকেট TxnId ৮-১৮ ডিজিটের (যেমন: 3876543210) হতে হবে!");
    if(curBrand==="upay"&&!/^[A-Z0-9]{7,20}$/.test(trx))return showFail(trx,"❌ উপায় TxnID ৭-২০ অক্ষরের কোড হতে হবে!");
    if(curBrand==="binance"&&!/^[A-Z0-9-]{6,26}$/.test(trx))return showFail(trx,"❌ Binance Pay Order/Pay ID কমপক্ষে ৬ অক্ষরের হতে হবে!");
    if(curBrand==="premium"&&!/^[A-Z0-9-]{6,24}$/.test(trx))return showFail(trx,"❌ Premium Transaction ID কমপক্ষে ৬ অক্ষরের হতে হবে!");
  }
  busy=true;setStep(3);beep([587,880],"triangle",0.16,0.14);
  var btn=document.getElementById("btnSub");btn.disabled=true;btn.innerText="যাচাই করা হচ্ছে... ⏳";
  document.getElementById("vModal").style.display="flex";
  var sec=10,waitExtra=0;document.getElementById("vSec").innerText=sec;document.getElementById("vProg").style.width="0%";playVerifyTick(sec);
  var resp=null,curInv=invId;
  fetch("/api/verify-trx",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({invoice_id:curInv,trxid:trx,method:curBrand,amount:invAmt})})
    .then(function(r){return r.json();})
    .then(function(r){resp=r;if(r&&r.invoiceId)curInv=r.invoiceId;})
    .catch(function(){resp={status:false,paymentStatus:"FAILED",message:"সার্ভার কানেকশনে সমস্যা হয়েছে।"};});
  var tm=setInterval(async function(){
    sec--;if(sec>0)playVerifyTick(sec);
    document.getElementById("vSec").innerText=Math.max(0,sec);document.getElementById("vProg").style.width=((10-Math.max(0,sec))*10)+"%";
    if(sec===7)document.getElementById("vLog").innerText="মেথড ও টাকার অঙ্ক পুঙ্খানুপুঙ্খ যাচাই চলছে...";
    if((sec===6||sec===3)&&resp&&resp.paymentStatus==="PENDING"&&curInv){
      document.getElementById("vLog").innerText="ক্লাউড সার্ভারে লেনদেন চূড়ান্ত হচ্ছে...";
      try{var chk=await fetch("/api/check-status?invoice_id="+encodeURIComponent(curInv)).then(function(x){return x.json();});if(chk&&(chk.status==="PAID"||chk.paymentStatus==="SUCCESS"))resp={status:true,paymentStatus:"SUCCESS",trxId:chk.trxId||trx,method:chk.method||curBrand,updatedBalance:chk.updatedBalance,verifiedAt:chk.paidAt,redirect_url:chk.redirect_url};}catch(e){}
    }
    if(resp&&(resp.status===true||resp.paymentStatus==="SUCCESS")){
      clearInterval(tm);document.getElementById("vModal").style.display="none";btn.disabled=false;btn.innerText="✈️ Submit Payment ➔";busy=false;paid=true;
      if(resp.redirect_url)redir=resp.redirect_url;showOk(trx,resp.method,resp.updatedBalance,resp.verifiedAt);return;
    }
    if(resp&&(resp.paymentStatus==="FAILED"||resp.paymentStatus==="REJECTED"||resp.paymentStatus==="EXPIRED")){
      clearInterval(tm);document.getElementById("vModal").style.display="none";btn.disabled=false;btn.innerText="✈️ Submit Payment ➔";busy=false;
      showFail(trx,resp.message||"Your transaction could not be verified. Please check your Transaction ID and try again.");return;
    }
    if(sec<=0){
      if(!resp&&waitExtra<8){waitExtra++;document.getElementById("vLog").innerText="সার্ভার যাচাই সম্পন্ন হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন...";return;}
      clearInterval(tm);document.getElementById("vModal").style.display="none";btn.disabled=false;btn.innerText="✈️ Submit Payment ➔";busy=false;
      if(resp&&resp.paymentStatus==="PENDING"){document.getElementById("pTrx").innerText=trx;document.getElementById("pModal").style.display="flex";beep([660,520],"sine",0.18,0.12);startPoll(curInv);}
      else showFail(trx,(resp&&resp.message)||"সার্ভার থেকে উত্তর আসতে দেরি হচ্ছে। দয়া করে আবার চেষ্টা করুন।");
    }
  },1000);
}
</script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 TopUpPro 6-Gateway VIP Server listening on port ${PORT}`));
module.exports = app;
