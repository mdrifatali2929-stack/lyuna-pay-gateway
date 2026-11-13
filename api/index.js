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

// 🛡️ কেন্দ্রীয় ফায়ারবেস কনফিগারেশন (admin.html ও ss.html-এর সাথে ১০০% সিঙ্কড)
const PROJECT_ID = "topuppro-4b458";
const RTDB_URL = "https://topuppro-4b458-default-rtdb.firebaseio.com";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyDcgQ0mzOfQhqyywHHfiJoxc12dfS9fbyQ";
const DEFAULT_REDIRECT = process.env.DEFAULT_REDIRECT_URL || "https://topuppro-4b458.web.app";

const executionLocks = new Set();
const ipRateLimitMap = new Map();

function checkRateLimit(ip, limit = 45, windowMs = 60000) {
  const now = Date.now();
  const entry = ipRateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 1; entry.resetAt = now + windowMs; }
  else { entry.count++; }
  ipRateLimitMap.set(ip, entry);
  return entry.count <= limit;
}

// =========================================================================
// 🔥 Raw HTTP/Fetch Helper with ETag Support for True Atomic RTDB CAS
// =========================================================================
async function rawRequest(url, options = {}) {
  if (typeof fetch !== "undefined") {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, ok: res.ok, data: json, etag: res.headers.get("etag") };
    } catch {
      return { status: 0, ok: false, data: null, etag: null };
    }
  }
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === "https:" ? https : http;
      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || "GET",
        headers: options.headers || {}
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json, etag: res.headers["etag"] || null });
        });
      });
      req.on("error", () => resolve({ status: 0, ok: false, data: null, etag: null }));
      req.setTimeout(9000, () => { req.destroy(); resolve({ status: 0, ok: false, data: null, etag: null }); });
      if (options.body) req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      req.end();
    } catch {
      resolve({ status: 0, ok: false, data: null, etag: null });
    }
  });
}

async function firebaseFetch(url, options = {}) {
  const res = await rawRequest(url, options);
  return res.data;
}

// True Server-Side Atomic Compare-And-Swap (CAS) on Firebase RTDB
async function rtdbAtomicTransaction(nodePath, mutatorFn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const getRes = await rawRequest(`${RTDB_URL}/${nodePath}.json`, {
      method: "GET",
      headers: { "X-Firebase-ETag": "true" }
    });
    if (!getRes.ok && getRes.status !== 404) return { committed: false, data: null };
    const nextVal = mutatorFn(getRes.data);
    if (nextVal === undefined) return { committed: false, aborted: true, data: getRes.data };

    const putHeaders = { "Content-Type": "application/json" };
    if (getRes.etag) putHeaders["If-Match"] = getRes.etag;

    const putRes = await rawRequest(`${RTDB_URL}/${nodePath}.json`, {
      method: "PUT",
      headers: putHeaders,
      body: JSON.stringify(nextVal)
    });
    if (putRes.ok) return { committed: true, data: putRes.data || nextVal, prevData: getRes.data };
    if (putRes.status !== 412) return { committed: false, data: null };
  }
  return { committed: false, data: null };
}

// =========================================================================
// 🛡️ Sanitizers & Method Format Validators (All 6 Gateways)
// =========================================================================
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sanitizeSafeUrl(url) {
  if (!url) return DEFAULT_REDIRECT;
  const t = String(url).trim();
  return (/^https?:\/\//i.test(t) || t.startsWith("/")) ? t : DEFAULT_REDIRECT;
}

function sanitizeRtdbKey(str) {
  return String(str || "").trim().replace(/[.#$\[\]\/]/g, "_");
}

function sanitizeText(str) {
  return str ? String(str).replace(/[<>'"&]/g, "").trim() : "";
}

function banglaToEngDigits(str) {
  const bn = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
  return String(str || "").replace(/[০-৯]/g, d => bn.indexOf(d));
}

function extractPureTrxId(rawInput) {
  if (!rawInput) return "";
  let str = banglaToEngDigits(String(rawInput)).trim().toUpperCase();
  str = str.replace(/^(?:TRXID|TXNID|TXN_ID|TRX_ID|TRX|TXN|ID|TRANS|TRANSACTION)[:\s#-]*/i, "");
  str = str.replace(/^[^\w]+|[^\w]+$/g, "").replace(/\s+/g, "");
  return str.trim();
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

function safeBrandKey(method) {
  const m = String(method || "bkash").toLowerCase().trim();
  if (m.includes("bkash")) return "bkash";
  if (m.includes("nagad")) return "nagad";
  if (m.includes("rocket")) return "rocket";
  if (m.includes("upay")) return "upay";
  if (m.includes("binance")) return "binance";
  if (m.includes("premium")) return "premium";
  return "bkash";
}

function validateMethodFormat(trx, method) {
  const m = safeBrandKey(method);
  if (trx.includes("_") || trx.startsWith("GIFT")) return { valid: true, isBonus: true };

  if (m === "bkash") {
    if (trx.length !== 10 || !/^[A-Z0-9]{10}$/.test(trx)) {
      if (trx.length === 8) return { valid: false, message: "❌ এটি নগদের ৮ ডিজিটের TxnID! বিকাশ TrxID ঠিক ১০ ডিজিটের (যেমন: BLG789ABCD) হতে হবে।" };
      if (/^[0-9]+$/.test(trx)) return { valid: false, message: "❌ এটি রকেটের নম্বর! বিকাশ TrxID অক্ষর ও সংখ্যার ১০ ডিজিট কোড হতে হবে।" };
      return { valid: false, message: "❌ বিকাশ TrxID ঠিক ১০ ডিজিটের আলফানিউমেরিক কোড (যেমন: BLG789ABCD) হতে হবে।" };
    }
  } else if (m === "nagad") {
    if (trx.length !== 8 || !/^[A-Z0-9]{8}$/.test(trx)) {
      if (trx.length === 10) return { valid: false, message: "❌ এটি বিকাশের ১০ ডিজিটের TrxID! নগদ TxnID ঠিক ৮ ডিজিটের (যেমন: 7K89ABCD) হতে হবে।" };
      if (/^[0-9]{9,16}$/.test(trx)) return { valid: false, message: "❌ এটি রকেটের নম্বর! নগদ TxnID ঠিক ৮ ডিজিটের হতে হবে।" };
      return { valid: false, message: "❌ নগদ TxnID ঠিক ৮ ডিজিটের কোড (যেমন: 7K89ABCD) হতে হবে।" };
    }
  } else if (m === "rocket") {
    if (!/^[0-9]{9,16}$/.test(trx)) {
      if (/[A-Z]/i.test(trx)) return { valid: false, message: "❌ এটি বিকাশ বা নগদের TrxID! রকেটের TxnId শুধুমাত্র সংখ্যা হতে হবে।" };
      return { valid: false, message: "❌ রকেট TxnId ৯ থেকে ১৬ ডিজিটের সংখ্যা হতে হবে (যেমন: 3876543210)।" };
    }
  } else if (m === "upay") {
    if (!/^[A-Z0-9]{8,14}$/.test(trx)) {
      return { valid: false, message: "❌ উপায় TxnID ৮ থেকে ১৪ অক্ষরের আলফানিউমেরিক কোড হতে হবে।" };
    }
  } else if (m === "binance") {
    if (!/^[A-Z0-9]{6,24}$/.test(trx)) {
      return { valid: false, message: "❌ Binance Pay Order/Pay ID কমপক্ষে ৬ অক্ষরের হতে হবে।" };
    }
  } else if (m === "premium") {
    if (!/^[A-Z0-9]{6,20}$/.test(trx)) {
      return { valid: false, message: "❌ Premium Transaction ID কমপক্ষে ৬ অক্ষরের হতে হবে।" };
    }
  }
  return { valid: true, isBonus: false };
}

// 🔍 ss.html sms_pool থেকে ৬টি মেথডের কঠোর ম্যাচিং (admin settings/auto_verify অনুযায়ী)
function findMatchingSmsInPool(smsData, cleanTrx, expectedAmount, requestedMethod, tolerance = 0) {
  if (!smsData || typeof smsData !== "object") return { notFound: true, error: "ব্যাংক SMS এখনো পৌঁছেনি।" };
  const entries = Object.entries(smsData).reverse();
  const reqBrand = safeBrandKey(requestedMethod);
  const tol = reqBrand === "binance" ? 0 : Math.max(0, Number(tolerance) || 0);

  let crossBrandFound = null;

  for (const [key, item] of entries) {
    if (!item) continue;
    if (item.used === true || item.used === "true" || item.match_status === "MATCHED") continue;

    const parsedTrx = extractPureTrxId(item.parsed_trx || "");
    if (!parsedTrx || parsedTrx !== cleanTrx) continue;

    const itemBrand = safeBrandKey(item.brandKey || item.brand || "");
    if (itemBrand !== reqBrand) {
      crossBrandFound = item.brand || "অন্য মেথড";
      continue;
    }

    let amt = parseFloat(item.parsed_amount);
    if (isNaN(amt) || amt <= 0) amt = parseFloat(item.amount) || 0;

    if (!isNaN(amt) && amt > 0) {
      if (Math.abs(amt - expectedAmount) <= tol) {
        return { success: true, key, item, matchedBrand: item.brand || requestedMethod, amount: amt };
      }
      return { mismatch: true, error: `টাকার অঙ্ক মেলেনি! ইনভয়েসের পরিমাণ ৳${expectedAmount}, কিন্তু প্রাপ্ত SMS-এ এসেছে ৳${amt}।` };
    }
  }

  if (crossBrandFound) {
    return { mismatch: true, error: `❌ মেথড অমিল! এটি [${crossBrandFound}]-এর ট্রানজেকশন। আপনি [${requestedMethod.toUpperCase()}] ঘরে দিয়েছেন!` };
  }

  return { notFound: true, error: "আপনার ট্রানজেকশনের ব্যাংক SMS এখনো পৌঁছেনি বা যাচাই চলমান।" };
}

// =========================================================================
// 🛡️ Double-Layer Atomic Fulfillment Engine (RTDB ETag + Firestore :commit)
// =========================================================================
async function executeFulfillment(invoiceId, cleanTrx, amount, brand = "bKash", smsKey = null, isBonus = false) {
  const safeTrx = sanitizeRtdbKey(cleanTrx);
  if (executionLocks.has(invoiceId) || executionLocks.has(safeTrx)) {
    return { ok: false, reason: "ট্রানজেকশনটি বর্তমানে প্রসেসিং অবস্থায় আছে।" };
  }
  executionLocks.add(invoiceId);
  executionLocks.add(safeTrx);

  try {
    // 1. RTDB Atomic Lock on processed_trx
    const procLock = await rtdbAtomicTransaction(`processed_trx/${safeTrx}`, (cur) => {
      if (cur !== null && cur.invoice_id !== invoiceId) return undefined;
      return {
        invoice_id: invoiceId,
        trx_id: cleanTrx,
        amount,
        method: brand,
        verified_at: Date.now(),
        verified_by: isBonus ? "BONUS_VOUCHER" : "GATEWAY_AUTO",
        status: "COMPLETED"
      };
    });
    if (!procLock.committed) {
      return { ok: false, reason: "❌ এই TrxID-টি ইতিমধ্যে অন্য একটি পেমেন্টে ব্যবহার করা হয়েছে!" };
    }

    // 2. RTDB Atomic Lock on invoices/${invoiceId} (keeps status: "PAID" so admin.html & ss.html match 100%)
    const invLock = await rtdbAtomicTransaction(`invoices/${invoiceId}`, (cur) => {
      if (!cur) return undefined;
      const st = String(cur.status || "").toUpperCase();
      if (st === "PAID" || st === "APPROVED" || st === "COMPLETED" || st === "SUCCESS") return undefined;
      return {
        ...cur,
        status: "PAID",
        trx_id: cleanTrx,
        method: brand,
        is_bonus: !!isBonus,
        paidAt: Date.now(),
        verifiedBy: isBonus ? "BONUS_VOUCHER" : "GATEWAY_AUTO"
      };
    });
    if (!invLock.committed || !invLock.prevData) {
      return { ok: false, reason: "⚠️ এই ইনভয়েসের পেমেন্ট ইতিমধ্যে সম্পন্ন হয়েছে!" };
    }

    const invoice = invLock.prevData;

    // 3. Mark sms_pool item USED & MATCHED (syncs with admin.html & ss.html)
    if (smsKey) {
      await firebaseFetch(`${RTDB_URL}/sms_pool/${smsKey}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          used: true,
          match_status: "MATCHED",
          matched_invoice: invoiceId,
          used_by_invoice: invoiceId,
          verified_at: new Date().toISOString()
        })
      });
    }

    const userId = invoice.userId || invoice.user_id || invoice.uid || "";
    const userEmail = invoice.userEmail || invoice.email || "Customer";
    const numAmt = parseFloat(invoice.amount) || amount;
    const details = cleanOrderDetails(invoice.order_details);
    const normType = String(invoice.order_type || "").toUpperCase().trim();
    const isDirectOrder =
      normType === "DIRECT_ORDER" ||
      normType.includes("ORDER") ||
      normType.includes("DIRECT") ||
      !!(details && (details.gameName || details.productName || details.product || details.playerId));

    let updatedBalance = null;

    // 4. Strictly Separate Product Order vs Add Balance (Firestore Atomic :commit)
    if (isDirectOrder) {
      const existingOrderId = details ? (details.orderId || details.order_id || details.id) : null;
      if (existingOrderId) {
        await firebaseFetch(`${FIRESTORE_BASE}/orders/${existingOrderId}?updateMask.fieldPaths=status&updateMask.fieldPaths=paymentStatus&updateMask.fieldPaths=trxId&key=${API_KEY}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              status: { stringValue: "processing" },
              paymentStatus: { stringValue: "paid" },
              trxId: { stringValue: cleanTrx }
            }
          })
        });
      } else {
        const orderDocId = `ORD_${invoiceId}`;
        const prodName = (details && ((details.product && details.product.name) || details.productName || (typeof details.product === "string" ? details.product : "Diamond Package"))) || "Diamond Package";
        const orderFields = {
          orderId: { stringValue: orderDocId },
          invoiceId: { stringValue: invoiceId },
          userId: { stringValue: userId },
          userName: { stringValue: userEmail },
          userEmail: { stringValue: userEmail },
          gameId: { stringValue: (details && details.gameId) || "" },
          gameName: { stringValue: (details && details.gameName) || "Game Order" },
          productName: { stringValue: prodName },
          price: { integerValue: String(Math.round(numAmt)) },
          playerId: { stringValue: (details && details.playerId) || "" },
          type: { stringValue: (details && details.type) || "uid" },
          status: { stringValue: "processing" },
          paymentStatus: { stringValue: "paid" },
          apiStatus: { stringValue: "pending_api" },
          paymentMethod: { stringValue: brand + " (Direct Gateway)" },
          trxId: { stringValue: cleanTrx },
          date: { timestampValue: new Date().toISOString() }
        };
        if (details && details.zoneId) orderFields.zoneId = { stringValue: String(details.zoneId) };
        if (details && details.accountType) orderFields.accountType = { stringValue: String(details.accountType) };
        if (details && details.contactPhone) orderFields.contactPhone = { stringValue: String(details.contactPhone) };

        await firebaseFetch(`${FIRESTORE_BASE}:commit?key=${API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            writes: [
              {
                currentDocument: { exists: false },
                update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/orders/${orderDocId}`, fields: orderFields }
              },
              {
                currentDocument: { exists: false },
                update: {
                  name: `projects/${PROJECT_ID}/databases/(default)/documents/transactions/TX_${invoiceId}`,
                  fields: {
                    txId: { stringValue: `TX_${invoiceId}` },
                    type: { stringValue: "DIRECT_ORDER" },
                    userId: { stringValue: userId },
                    userEmail: { stringValue: userEmail },
                    amount: { doubleValue: numAmt },
                    method: { stringValue: brand },
                    trxId: { stringValue: cleanTrx },
                    invoiceId: { stringValue: invoiceId },
                    orderId: { stringValue: orderDocId },
                    status: { stringValue: "SUCCESS" },
                    createdAt: { timestampValue: new Date().toISOString() }
                  }
                }
              }
            ]
          })
        });
      }
    } else if (userId) {
      // Atomic Optimistic-Concurrency Commit for User Balance + Deposit + Transaction
      for (let retry = 0; retry < 3; retry++) {
        const userDoc = await firebaseFetch(`${FIRESTORE_BASE}/users/${userId}?key=${API_KEY}`);
        if (!userDoc || !userDoc.fields) break;

        const currentBal = parseFloat(
          userDoc.fields.balance?.doubleValue ??
          userDoc.fields.balance?.integerValue ??
          userDoc.fields.balance?.stringValue ??
          0
        ) || 0;
        const newBal = Number((currentBal + numAmt).toFixed(2));
        updatedBalance = newBal;

        const commitRes = await rawRequest(`${FIRESTORE_BASE}:commit?key=${API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            writes: [
              {
                currentDocument: { updateTime: userDoc.updateTime },
                updateMask: { fieldPaths: ["balance"] },
                update: {
                  name: `projects/${PROJECT_ID}/databases/(default)/documents/users/${userId}`,
                  fields: { balance: { doubleValue: newBal } }
                }
              },
              {
                currentDocument: { exists: false },
                update: {
                  name: `projects/${PROJECT_ID}/databases/(default)/documents/deposits/DEP_${invoiceId}`,
                  fields: {
                    depositId: { stringValue: `DEP_${invoiceId}` },
                    invoiceId: { stringValue: invoiceId },
                    userId: { stringValue: userId },
                    userEmail: { stringValue: userEmail },
                    amount: { doubleValue: numAmt },
                    previousBalance: { doubleValue: currentBal },
                    newBalance: { doubleValue: newBal },
                    method: { stringValue: brand },
                    senderPhone: { stringValue: "Auto Verified" },
                    trxId: { stringValue: cleanTrx },
                    status: { stringValue: "approved" },
                    date: { timestampValue: new Date().toISOString() }
                  }
                }
              },
              {
                currentDocument: { exists: false },
                update: {
                  name: `projects/${PROJECT_ID}/databases/(default)/documents/transactions/TX_${invoiceId}`,
                  fields: {
                    txId: { stringValue: `TX_${invoiceId}` },
                    type: { stringValue: "ADD_BALANCE" },
                    userId: { stringValue: userId },
                    userEmail: { stringValue: userEmail },
                    amount: { doubleValue: numAmt },
                    previousBalance: { doubleValue: currentBal },
                    newBalance: { doubleValue: newBal },
                    method: { stringValue: brand },
                    trxId: { stringValue: cleanTrx },
                    invoiceId: { stringValue: invoiceId },
                    status: { stringValue: "SUCCESS" },
                    createdAt: { timestampValue: new Date().toISOString() }
                  }
                }
              }
            ]
          })
        });
        if (commitRes.ok) break;
        if (commitRes.status !== 409) break;
      }
    }

    // 5. Single Notification + Live Fulfillment Feed
    await rtdbAtomicTransaction(`notifications/${invoiceId}`, (cur) => {
      if (cur !== null) return undefined;
      return {
        userId,
        title: "Payment Successful!",
        message: isDirectOrder ? "Your product order has been confirmed." : "Your balance has been added successfully.",
        invoiceId,
        trxId: cleanTrx,
        amount: numAmt,
        method: brand,
        updatedBalance,
        type: "SUCCESS",
        createdAt: Date.now()
      };
    });

    await firebaseFetch(`${RTDB_URL}/live_fulfillment_feed.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invoiceId, userId, userEmail,
        orderType: isDirectOrder ? "DIRECT_ORDER" : "ADD_BALANCE",
        orderDetails: isDirectOrder ? details : null,
        amount: numAmt, trxId: cleanTrx, method: brand, status: "APPROVED",
        timestamp: Date.now(), timeStr: new Date().toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit" })
      })
    });

    return { ok: true, updatedBalance, verifiedAt: Date.now(), redirectUrl: sanitizeSafeUrl(invoice.redirect_url) };
  } catch (err) {
    console.error("❌ Fulfillment Error:", err);
    return { ok: false, reason: "সার্ভার প্রসেসিং এরর।" };
  } finally {
    setTimeout(() => { executionLocks.delete(invoiceId); executionLocks.delete(safeTrx); }, 15000);
  }
}

app.get("/", (req, res) => {
  res.send("<h1 style='font-family:sans-serif;text-align:center;margin-top:60px'>🚀 TopUpPro 6-Gateway Atomic Server Online</h1>");
});

// =========================================================================
// 1. CREATE PAYMENT API (Idempotent + Unique Invoice ID)
// =========================================================================
app.all(["/api/create-payment", "/api/payment/create", "/create-payment"], async (req, res) => {
  try {
    const dataObj = req.method === "POST" ? (req.body || {}) : (req.query || {});
    let cleanAmount = parseFloat(String(dataObj.amount || 500).replace(/[^0-9.]/g, "")) || 500;
    cleanAmount = Math.max(1, Math.min(100000, cleanAmount));

    const meta = dataObj.metadata || {};
    const userId = sanitizeText(meta.userId || dataObj.userId || dataObj.uid || "");
    const userEmail = sanitizeText(dataObj.email || dataObj.user_email || "Customer");
    const idempotencyKey = sanitizeRtdbKey(req.headers["x-idempotency-key"] || dataObj.idempotencyKey || "");
    const orderDetails = cleanOrderDetails(meta.orderDetails || dataObj.order_details || meta.order_details || dataObj.orderDetails);
    const rawType = String(meta.orderType || dataObj.order_type || meta.order_type || dataObj.orderType || "").toUpperCase();

    const orderType = (rawType.includes("ORDER") || rawType.includes("DIRECT") || rawType.includes("PRODUCT") ||
      (orderDetails && (orderDetails.gameName || orderDetails.productName || orderDetails.product)))
      ? "DIRECT_ORDER" : "ADD_BALANCE";

    const redirect_url = sanitizeSafeUrl(dataObj.redirect_url);
    const host = req.headers.host || "localhost:3000";
    const protocol = req.headers["x-forwarded-proto"] || "http";

    if (idempotencyKey) {
      const idem = await firebaseFetch(`${RTDB_URL}/idempotency/${idempotencyKey}.json`);
      if (idem && idem.invoice_id) {
        return res.status(200).json({
          status: true, message: "Payment Initiated", invoice_id: idem.invoice_id,
          payment_url: `${protocol}://${host}/checkout?invoice_id=${idem.invoice_id}`
        });
      }
    }

    const invoice_id = "TPP" + Date.now().toString().slice(-10) + crypto.randomInt(10, 99);
    await firebaseFetch(`${RTDB_URL}/invoices/${invoice_id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invoice_id, amount: cleanAmount, userId, userEmail, order_type: orderType,
        order_details: orderDetails, redirect_url, status: "PENDING",
        createdAt: Date.now(), expiresAt: Date.now() + 15 * 60 * 1000
      })
    });

    if (idempotencyKey) {
      await firebaseFetch(`${RTDB_URL}/idempotency/${idempotencyKey}.json`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id, createdAt: Date.now() })
      });
    }

    return res.status(200).json({
      status: true, message: "Payment Initiated", invoice_id,
      payment_url: `${protocol}://${host}/checkout?invoice_id=${invoice_id}`
    });
  } catch {
    return res.status(500).json({ status: false, message: "ইনভয়েস তৈরি করা যায়নি।" });
  }
});

// =========================================================================
// 2. ATOMIC PRODUCT PURCHASE USING WALLET BALANCE (Separate from Add Balance)
// =========================================================================
app.post("/api/purchase-product", async (req, res) => {
  try {
    const { userId, userEmail, productId, playerId, idempotencyKey } = req.body || {};
    const cleanUid = sanitizeText(userId);
    const cleanPid = sanitizeText(productId);
    const cleanPlayer = sanitizeText(playerId);
    const cleanIdem = sanitizeRtdbKey(req.headers["x-idempotency-key"] || idempotencyKey || "");

    if (!cleanUid || !cleanPid || !cleanPlayer || !cleanIdem) {
      return res.status(400).json({ status: false, message: "প্রয়োজনীয় তথ্য (User, Product, Player ID, Idempotency) অসম্পূর্ণ।" });
    }

    const orderId = `ORD_${cleanIdem}`;
    const existingOrder = await firebaseFetch(`${FIRESTORE_BASE}/orders/${orderId}?key=${API_KEY}`);
    if (existingOrder && existingOrder.fields) {
      return res.status(200).json({ status: true, alreadyCreated: true, orderId, message: "অর্ডারটি ইতিমধ্যে তৈরি হয়েছে!" });
    }

    const prodDoc = await firebaseFetch(`${FIRESTORE_BASE}/products/${cleanPid}?key=${API_KEY}`);
    if (!prodDoc || !prodDoc.fields) return res.status(404).json({ status: false, message: "পণ্যটি খুঁজে পাওয়া যায়নি।" });
    if (prodDoc.fields.available?.booleanValue === false) return res.status(400).json({ status: false, message: "পণ্যটি স্টকে নেই।" });

    const prodName = prodDoc.fields.name?.stringValue || "Product";
    const prodCat = prodDoc.fields.category?.stringValue || "Game";
    const price = parseFloat(prodDoc.fields.price?.doubleValue ?? prodDoc.fields.price?.integerValue ?? prodDoc.fields.price?.stringValue ?? 0) || 0;
    if (price <= 0) return res.status(400).json({ status: false, message: "পণ্যের মূল্য সঠিক নয়।" });

    const userDoc = await firebaseFetch(`${FIRESTORE_BASE}/users/${cleanUid}?key=${API_KEY}`);
    if (!userDoc || !userDoc.fields) return res.status(404).json({ status: false, message: "ইউজার অ্যাকাউন্ট পাওয়া যায়নি।" });
    if (userDoc.fields.blocked?.booleanValue === true) return res.status(403).json({ status: false, message: "অ্যাকাউন্ট ব্লক করা হয়েছে।" });

    const prevBal = parseFloat(userDoc.fields.balance?.doubleValue ?? userDoc.fields.balance?.integerValue ?? userDoc.fields.balance?.stringValue ?? 0) || 0;
    if (prevBal < price) return res.status(400).json({ status: false, message: `পর্যাপ্ত ব্যালেন্স নেই! প্রয়োজন ৳${price}, আপনার ব্যালেন্স ৳${prevBal}` });

    const newBal = Number((prevBal - price).toFixed(2));
    const commitRes = await rawRequest(`${FIRESTORE_BASE}:commit?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        writes: [
          {
            currentDocument: { updateTime: userDoc.updateTime },
            updateMask: { fieldPaths: ["balance"] },
            update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/users/${cleanUid}`, fields: { balance: { doubleValue: newBal } } }
          },
          {
            currentDocument: { exists: false },
            update: {
              name: `projects/${PROJECT_ID}/databases/(default)/documents/orders/${orderId}`,
              fields: {
                orderId: { stringValue: orderId }, userId: { stringValue: cleanUid },
                userEmail: { stringValue: sanitizeText(userEmail || userDoc.fields.email?.stringValue || "") },
                productId: { stringValue: cleanPid }, productName: { stringValue: prodName },
                category: { stringValue: prodCat }, price: { doubleValue: price },
                playerId: { stringValue: cleanPlayer }, status: { stringValue: "pending" },
                paymentStatus: { stringValue: "paid" }, paymentMethod: { stringValue: "Wallet Balance" },
                date: { timestampValue: new Date().toISOString() }
              }
            }
          },
          {
            currentDocument: { exists: false },
            update: {
              name: `projects/${PROJECT_ID}/databases/(default)/documents/transactions/TX_${orderId}`,
              fields: {
                txId: { stringValue: `TX_${orderId}` }, type: { stringValue: "PRODUCT_PURCHASE" },
                userId: { stringValue: cleanUid }, amount: { doubleValue: -price },
                previousBalance: { doubleValue: prevBal }, newBalance: { doubleValue: newBal },
                orderId: { stringValue: orderId }, status: { stringValue: "SUCCESS" },
                createdAt: { timestampValue: new Date().toISOString() }
              }
            }
          }
        ]
      })
    });

    if (!commitRes.ok) {
      return res.status(409).json({ status: false, message: "ব্যালেন্স পরিবর্তিত হয়েছে বা ডুপ্লিকেট চেষ্টা। আবার চেষ্টা করুন।" });
    }
    return res.status(200).json({ status: true, orderId, newBalance: newBal, productName: prodName, price, message: "অর্ডার সফলভাবে সম্পন্ন হয়েছে!" });
  } catch (err) {
    return res.status(500).json({ status: false, message: "অর্ডার এরর: " + err.message });
  }
});

// =========================================================================
// 3. CHECK STATUS API (Live Polling for Pending -> Paid/Rejected/Expired)
// =========================================================================
app.get("/api/check-status", async (req, res) => {
  const invoice_id = sanitizeText(req.query.invoice_id);
  if (!invoice_id) return res.json({ status: "UNKNOWN" });
  try {
    const inv = await firebaseFetch(`${RTDB_URL}/invoices/${invoice_id}.json`);
    if (!inv) return res.json({ status: "NOT_FOUND" });
    const st = String(inv.status || "PENDING").toUpperCase();
    let updatedBalance = null;
    if ((st === "PAID" || st === "APPROVED" || st === "COMPLETED" || st === "SUCCESS") && inv.userId) {
      const uDoc = await firebaseFetch(`${FIRESTORE_BASE}/users/${inv.userId}?key=${API_KEY}`);
      if (uDoc && uDoc.fields?.balance) {
        updatedBalance = parseFloat(uDoc.fields.balance.doubleValue ?? uDoc.fields.balance.integerValue ?? 0) || 0;
      }
    }
    return res.json({
      status: st,
      paymentStatus: (st === "PAID" || st === "APPROVED" || st === "COMPLETED" || st === "SUCCESS") ? "SUCCESS" : st,
      trxId: inv.trx_id || "",
      amount: inv.amount,
      method: inv.method || "",
      updatedBalance,
      paidAt: inv.paidAt || null,
      redirect_url: sanitizeSafeUrl(inv.redirect_url)
    });
  } catch {
    return res.json({ status: "ERROR" });
  }
});

// =========================================================================
// 4. VERIFY PAYMENT API (6-Gateway + Admin Settings Sync + Pending Support)
// =========================================================================
app.all(["/api/verify-trx", "/api/verify-payment"], async (req, res) => {
  try {
    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "অতিরিক্ত চেষ্টা করা হয়েছে। ১ মিনিট পর চেষ্টা করুন।" });
    }

    const data = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const invoice_id = sanitizeText(data.invoice_id);
    const method = sanitizeText(data.method || "bKash");
    const brandKey = safeBrandKey(method);
    const cleanTrx = extractPureTrxId(data.trxid || data.trx_id || "");

    if (!cleanTrx || cleanTrx.length < 4) {
      return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "দয়া করে সঠিক Transaction ID লিখুন!" });
    }

    const formatCheck = validateMethodFormat(cleanTrx, brandKey);
    if (!formatCheck.valid) {
      return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: formatCheck.message });
    }

    let invoice = null;
    if (invoice_id) {
      invoice = await firebaseFetch(`${RTDB_URL}/invoices/${invoice_id}.json`);
      if (!invoice) {
        return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "ইনভয়েস খুঁজে পাওয়া যায়নি!" });
      }
      const curSt = String(invoice.status || "").toUpperCase();
      if (curSt === "PAID" || curSt === "APPROVED" || curSt === "COMPLETED" || curSt === "SUCCESS") {
        return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "⚠️ এই ইনভয়েসের পেমেন্ট ইতিমধ্যে সফল হয়েছে!" });
      }
      if (curSt === "REJECTED") {
        return res.status(200).json({ status: false, paymentStatus: "REJECTED", title: "Payment Failed!", message: "❌ অ্যাডমিন এই ইনভয়েসটি বাতিল করেছেন।" });
      }
      if (invoice.expiresAt && Date.now() > invoice.expiresAt) {
        await firebaseFetch(`${RTDB_URL}/invoices/${invoice_id}.json`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "EXPIRED" }) });
        return res.status(200).json({ status: false, paymentStatus: "EXPIRED", title: "Payment Failed!", message: "⏰ ইনভয়েসের মেয়াদ শেষ (Expired)!" });
      }
    }

    // Check Admin Gateway Rules (Enabled, Min/Max)
    const gw = await firebaseFetch(`${RTDB_URL}/settings/gateways/${brandKey}.json`);
    if (gw && gw.enabled === false) {
      return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "এই পেমেন্ট মেথডটি বর্তমানে বন্ধ আছে।" });
    }

    const expectedAmount = invoice ? parseFloat(invoice.amount) : (parseFloat(data.amount) || 0);
    if (gw && ((gw.min_amount && expectedAmount < Number(gw.min_amount)) || (gw.max_amount && expectedAmount > Number(gw.max_amount)))) {
      return res.status(200).json({
        status: false, paymentStatus: "FAILED", title: "Payment Failed!",
        message: `এই মেথডে সর্বনিম্ন ৳${gw.min_amount} এবং সর্বোচ্চ ৳${gw.max_amount} পেমেন্ট করা যায়।`
      });
    }

    // Single-Use Duplicate Lock Check
    const safeTrx = sanitizeRtdbKey(cleanTrx);
    const lockData = await firebaseFetch(`${RTDB_URL}/processed_trx/${safeTrx}.json`);
    if (lockData && (lockData.status === "COMPLETED" || lockData.verified_at)) {
      return res.status(200).json({
        status: false, paymentStatus: "FAILED", title: "Payment Failed!",
        message: "❌ এই TrxID-টি ইতিমধ্যে অন্য একটি পেমেন্টে ব্যবহার করা হয়েছে! একটি ট্রানজেকশন একাধিকবার ব্যবহার করা যাবে না।"
      });
    }

    // Check 1: Admin Bonus Vouchers
    const allVouchers = await firebaseFetch(`${RTDB_URL}/bonus_vouchers.json`);
    if (allVouchers && typeof allVouchers === "object") {
      let matchedKey = null, vData = null;
      for (const [k, v] of Object.entries(allVouchers)) {
        if (!v) continue;
        if (extractPureTrxId(k) === cleanTrx || extractPureTrxId(v.trx_id || k) === cleanTrx) {
          matchedKey = k; vData = v; break;
        }
      }
      if (vData) {
        if (vData.used === true || vData.status === "CLAIMED") {
          return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "❌ এই বোনাস/গিফট কোডটি ইতিমধ্যে ব্যবহার করা হয়েছে!" });
        }
        if (vData.method && safeBrandKey(vData.method) !== brandKey) {
          return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: `❌ এই বোনাস কোডটি [${vData.method}]-এর জন্য তৈরি!` });
        }
        const vAmt = parseFloat(vData.amount) || 0;
        if (vAmt > 0 && Math.abs(vAmt - expectedAmount) > 0.01) {
          return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: `❌ টাকার অঙ্ক মিলেনি! এটি ৳${vAmt} টাকার কোড, কিন্তু ইনভয়েস ৳${expectedAmount} টাকার।` });
        }

        await firebaseFetch(`${RTDB_URL}/bonus_vouchers/${matchedKey}.json`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ used: true, status: "CLAIMED", claimed_by: invoice_id || "DIRECT", claimed_at: Date.now() })
        });

        const resFulfill = await executeFulfillment(invoice_id, cleanTrx, expectedAmount, vData.method || method, null, true);
        if (!resFulfill.ok) return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: resFulfill.reason });

        return res.status(200).json({
          status: true, paymentStatus: "SUCCESS", title: "Payment Successful!", message: "Your balance has been added successfully.",
          trxId: cleanTrx, amount: expectedAmount, method: vData.method || method, invoiceId: invoice_id,
          updatedBalance: resFulfill.updatedBalance, verifiedAt: resFulfill.verifiedAt, redirect_url: resFulfill.redirectUrl
        });
      }
    }

    // Check 2: SMS Pool Match (Reads admin settings/auto_verify tolerance)
    const autoCfg = await firebaseFetch(`${RTDB_URL}/settings/auto_verify.json`);
    const tol = (autoCfg && autoCfg.tolerance !== undefined) ? Number(autoCfg.tolerance) : 2;
    const smsData = await firebaseFetch(`${RTDB_URL}/sms_pool.json`);
    const matchResult = findMatchingSmsInPool(smsData, cleanTrx, expectedAmount, brandKey, tol);

    if (matchResult.success) {
      const resFulfill = await executeFulfillment(invoice_id, cleanTrx, matchResult.amount, matchResult.matchedBrand, matchResult.key, false);
      if (!resFulfill.ok) return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: resFulfill.reason });

      return res.status(200).json({
        status: true, paymentStatus: "SUCCESS", title: "Payment Successful!", message: "Your balance has been added successfully.",
        trxId: cleanTrx, amount: matchResult.amount, method: matchResult.matchedBrand, invoiceId: invoice_id,
        updatedBalance: resFulfill.updatedBalance, verifiedAt: resFulfill.verifiedAt, redirect_url: resFulfill.redirectUrl
      });
    }

    if (matchResult.mismatch) {
      return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: matchResult.error });
    }

    // Save TrxID onto PENDING invoice so ss.html / admin.html auto-matches when SMS arrives
    if (invoice_id) {
      await firebaseFetch(`${RTDB_URL}/invoices/${invoice_id}.json`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trx_id: cleanTrx, method: brandKey, submittedAt: Date.now() })
      });
    }

    return res.status(200).json({
      status: false, paymentStatus: "PENDING", title: "Payment Under Verification",
      message: "Your payment is being verified. Please wait for confirmation.",
      invoiceId: invoice_id, trxId: cleanTrx
    });
  } catch {
    return res.status(200).json({ status: false, paymentStatus: "FAILED", title: "Payment Failed!", message: "Your transaction could not be verified. Please check your Transaction ID and try again." });
  }
});

// =========================================================================
// 5. RESTORED & UPGRADED 6-GATEWAY VIP CHECKOUT PAGE (/checkout)
// =========================================================================
app.get("/checkout", async (req, res) => {
  const invoice_id = sanitizeText(req.query.invoice_id);
  const invoice = invoice_id ? await firebaseFetch(`${RTDB_URL}/invoices/${invoice_id}.json`) : null;

  const curStatus = invoice ? String(invoice.status || "").toUpperCase() : "PENDING";
  const isAlreadyPaid = curStatus === "PAID" || curStatus === "APPROVED" || curStatus === "COMPLETED" || curStatus === "SUCCESS";

  let payableAmount = invoice ? parseFloat(invoice.amount) : parseFloat(String(req.query.amount || 500).replace(/[^0-9.]/g, ""));
  if (isNaN(payableAmount) || payableAmount < 1) payableAmount = 10;
  if (payableAmount > 100000) payableAmount = 100000;

  const displayInvoice = invoice_id || ("#TPP" + Date.now().toString().slice(-10));
  const redirectUrl = sanitizeSafeUrl(invoice && invoice.redirect_url);
  const orderDetails = cleanOrderDetails(invoice && invoice.order_details);
  const orderType = (invoice && invoice.order_type) || "ADD_BALANCE";
  const isDirectOrder = (orderType === "DIRECT_ORDER" || orderType.includes("ORDER")) || !!(orderDetails && (orderDetails.gameName || orderDetails.productName));
  const userId = (invoice && invoice.userId) || "";
  const supportPin = "PIN-" + (invoice_id ? invoice_id.slice(-4) : "2489");

  let userCurrentBal = 0;
  if (userId) {
    try {
      const uDoc = await firebaseFetch(`${FIRESTORE_BASE}/users/${userId}?key=${API_KEY}`);
      if (uDoc && uDoc.fields?.balance) {
        userCurrentBal = parseFloat(uDoc.fields.balance.doubleValue ?? uDoc.fields.balance.integerValue ?? uDoc.fields.balance.stringValue ?? 0) || 0;
      }
    } catch {}
  }
  const userAfterBal = userCurrentBal + payableAmount;

  // Load all 6 Gateways dynamically from Admin Panel settings/gateways
  const gSnap = await firebaseFetch(`${RTDB_URL}/settings/gateways.json`);
  const numSnap = await firebaseFetch(`${RTDB_URL}/settings/numbers.json`);

  const methodsMeta = [
    { key: "bkash", name: "bKash", logo: "/assets/payment-logos/bkash.svg", color: "#E2136E", defNum: "01825760029", defMin: 10, defMax: 25000, defDesc: "বিকাশ অ্যাপ ওপেন করে সেন্ড মানি করুন এবং TrxID বসান" },
    { key: "nagad", name: "Nagad", logo: "/assets/payment-logos/nagad.svg", color: "#F97316", defNum: "01825760029", defMin: 10, defMax: 25000, defDesc: "নগদ অ্যাপ থেকে সেন্ড মানি করুন এবং প্রাপ্ত TxnID দিন" },
    { key: "rocket", name: "Rocket", logo: "/assets/payment-logos/rocket.svg", color: "#8C30F5", defNum: "01965101494", defMin: 10, defMax: 25000, defDesc: "Rocket App বা *322# ডায়াল করে সেন্ড মানি করুন" },
    { key: "upay", name: "Upay", logo: "/assets/payment-logos/upay.svg", color: "#0081C6", defNum: "01825760029", defMin: 10, defMax: 25000, defDesc: "Upay অ্যাপ থেকে সেন্ড মানি করে TxnID দিন" },
    { key: "binance", name: "Binance Pay", logo: "/assets/payment-logos/binance-pay.svg", color: "#F3BA2F", defNum: "Binance Pay ID", defMin: 1, defMax: 5000, defDesc: "Binance Pay থেকে পেমেন্ট সম্পন্ন করে Order ID দিন" },
    { key: "premium", name: "Premium", logo: "/assets/payment-logos/premium.svg", color: "#D97706", defNum: "Premium Wallet", defMin: 50, defMax: 50000, defDesc: "Premium Wallet-এ পেমেন্ট সম্পন্ন করে Transaction ID দিন" }
  ];

  const gatewayConfig = {};
  methodsMeta.forEach(m => {
    const g = (gSnap && gSnap[m.key]) || {};
    let activeNum = g.number || "";
    if (!activeNum && g.numbers) {
      const arr = Array.isArray(g.numbers) ? g.numbers : Object.values(g.numbers);
      const act = arr.find(n => n && n.active);
      if (act && act.number) activeNum = act.number;
    }
    if (!activeNum && numSnap && numSnap[m.key]) activeNum = numSnap[m.key];
    gatewayConfig[m.key] = {
      key: m.key, name: m.name, color: m.color,
      enabled: g.enabled !== false,
      number: activeNum || m.defNum,
      type: g.type || "Send Money",
      logo: g.logo_img || m.logo,
      type_img: g.type_img || g.qr_image || "",
      min_amount: Number(g.min_amount ?? m.defMin),
      max_amount: Number(g.max_amount ?? m.defMax),
      desc: g.desc || m.defDesc
    };
  });

  const enabledMethods = methodsMeta.filter(m => gatewayConfig[m.key].enabled);
  const firstBrand = enabledMethods.length ? enabledMethods[0].key : "bkash";

  const safeGameName = escapeHtml((orderDetails && orderDetails.gameName) || "Game Order");
  const safeProdName = detailsSafe((orderDetails && ((orderDetails.product && orderDetails.product.name) || orderDetails.productName || orderDetails.product)) || "Diamond Package");
  const safePlayerId = escapeHtml((orderDetails && orderDetails.playerId) || "N/A");

  res.send(`<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Instant VIP Checkout &bull; TOPUPPRO</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800;900&family=Hind+Siliguri:wght@500;600;700;800&family=JetBrains+Mono:wght@600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root{--bg-page:#0a0e23;--card-white:#ffffff;--brand-purple:#4f46e5;--brand-purple-light:#eef2ff;--gold:#f59e0b;--gold-grad:linear-gradient(135deg,#fef08a 0%,#facc15 40%,#f59e0b 90%);--emerald:#10b981;--danger:#ef4444;--text-dark:#0f172a;--text-muted:#64748b;--border-soft:#e2e8f0;--shadow-elevated:0 18px 45px rgba(0,0,0,0.22),0 4px 14px rgba(0,0,0,0.08)}
    *{box-sizing:border-box;margin:0;padding:0;font-family:'Plus Jakarta Sans','Hind Siliguri',sans-serif;-webkit-tap-highlight-color:transparent}
    body{min-height:100vh;background:radial-gradient(circle at 50% -10%,#1e1354 0%,#0b0f28 50%,#020617 100%);color:var(--text-dark);display:flex;flex-direction:column;align-items:center;padding:14px 10px 50px;position:relative;overflow-x:hidden}
    .top-navbar{width:100%;max-width:960px;display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:var(--card-white);border:1.5px solid var(--border-soft);border-radius:20px;margin-bottom:14px;box-shadow:var(--shadow-elevated)}
    .brand-logo-wrap{display:flex;align-items:center;gap:10px;text-decoration:none}
    .brand-logo-icon{width:40px;height:40px;background:linear-gradient(135deg,#090b10,#f59e0b);border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#fde047}
    .brand-title h2{font-size:17px;font-weight:900;color:var(--text-dark)}
    .brand-title p{font-size:9.5px;color:var(--text-muted);font-weight:700}
    .user-pill{background:var(--brand-purple-light);border:1.5px solid #c7d2fe;padding:7px 14px;border-radius:12px;font-size:12.5px;font-weight:900;color:var(--brand-purple)}
    .payment-master-box{width:100%;max-width:960px;background:var(--card-white);border-radius:26px;padding:22px 18px;box-shadow:var(--shadow-elevated);border:1.5px solid var(--border-soft);margin-bottom:18px}
    @media(min-width:768px){.payment-master-box{padding:28px 24px}}
    .card-header-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px}
    .card-header-title{display:flex;align-items:center;gap:10px}
    .header-icon-wallet{width:42px;height:42px;border-radius:14px;background:#e0e7ff;display:flex;align-items:center;justify-content:center;font-size:22px}
    .card-header-title h3{font-size:18px;font-weight:900;color:#0f172a}
    .card-header-title p{font-size:11.5px;color:var(--text-muted);font-weight:700}
    .badge-encrypted{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;padding:6px 14px;border-radius:20px;font-size:11.5px;font-weight:800}
    .methods-selector-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:18px}
    @media(min-width:640px){.methods-selector-grid{grid-template-columns:repeat(3,1fr)}}
    @media(min-width:900px){.methods-selector-grid{grid-template-columns:repeat(6,1fr)}}
    .method-card{background:#fff;border:2px solid var(--border-soft);border-radius:18px;padding:12px 6px;text-align:center;cursor:pointer;position:relative;transition:0.2s}
    .method-card:hover{transform:translateY(-2px);border-color:#cbd5e1}
    .method-card.active{border-color:#090b10;background:linear-gradient(180deg,#fffbeb,#fef3c7);box-shadow:0 6px 18px rgba(245,158,11,0.24)}
    .active-check{position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:50%;background:#090b10;color:#fde047;font-size:10px;display:none;align-items:center;justify-content:center;font-weight:900}
    .method-card.active .active-check{display:flex}
    .method-logo-img{height:36px;display:flex;align-items:center;justify-content:center;margin-bottom:4px}
    .method-logo-img img{height:32px;max-width:44px;object-fit:contain}
    .method-card h4{font-size:13px;font-weight:900}
    .method-card p{font-size:10px;color:var(--text-muted);font-weight:700}
    .payment-split-grid{display:grid;grid-template-columns:1fr;gap:16px}
    @media(min-width:768px){.payment-split-grid{grid-template-columns:1.15fr 1fr}}
    .details-subcard,.trx-subcard{background:#f8fafc;border:1.5px solid var(--border-soft);border-radius:20px;padding:16px}
    .subcard-title{font-size:14.5px;font-weight:900;color:#0f172a;margin-bottom:12px}
    .number-display-box{background:#fff;border:1.5px solid var(--border-soft);border-radius:14px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px}
    .num-info span{font-size:10.5px;color:var(--text-muted);font-weight:800;display:block}
    .num-info b{font-family:'JetBrains Mono',monospace;font-size:16.5px;font-weight:900;color:#0f172a;word-break:break-all}
    .btn-copy{background:var(--brand-purple);color:#fff;border:none;padding:8px 14px;border-radius:10px;font-size:11.5px;font-weight:800;cursor:pointer;white-space:nowrap}
    .payment-banner-wrap{width:100%;height:132px;border-radius:14px;overflow:hidden;background:#e2e8f0;margin-bottom:12px;border:1px solid #cbd5e1}
    .payment-banner-wrap img{width:100%;height:100%;object-fit:cover}
    .instruction-box{background:#fff;border:1.5px solid var(--border-soft);border-radius:14px;padding:12px}
    .instruction-box h5{font-size:11.5px;font-weight:800;color:var(--brand-purple);margin-bottom:8px}
    .step-row{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:700;color:#334155;margin-bottom:6px}
    .step-circle{width:20px;height:20px;border-radius:50%;background:var(--brand-purple);color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .trx-mode-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    .trx-main-field{width:100%;background:#fff;border:2px solid #cbd5e1;border-radius:14px;padding:12px 14px;font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:900;color:#0f172a;outline:none;text-transform:uppercase;margin-bottom:10px}
    .trx-main-field:focus{border-color:var(--brand-purple);box-shadow:0 0 14px rgba(79,70,229,0.2)}
    .btn-paste-unified{background:var(--brand-purple-light);color:var(--brand-purple);border:1px solid #c7d2fe;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer}
    .statement-card{background:#fff;border:1.5px solid var(--border-soft);border-radius:14px;padding:12px 14px;margin-bottom:12px}
    .stmt-head{display:flex;justify-content:space-between;font-size:11px;font-weight:800;color:var(--brand-purple);margin-bottom:8px;border-bottom:1px dashed #e2e8f0;padding-bottom:6px}
    .stmt-row{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;padding:3px 0}
    .stmt-row span{color:var(--text-muted);font-weight:600}
    .stmt-row b{font-family:'JetBrains Mono',monospace;color:#0f172a}
    .meta-stats-strip{display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#fff;border:1px solid var(--border-soft);border-radius:14px;padding:10px;margin-bottom:14px;text-align:center}
    .meta-stats-strip span{font-size:10px;color:var(--text-muted);font-weight:700;display:block}
    .meta-stats-strip b{font-family:'JetBrains Mono',monospace;font-size:13.5px;font-weight:900}
    .btn-submit-main{width:100%;border:none;border-radius:16px;padding:16px;background:linear-gradient(90deg,#4f46e5 0%,#06b6d4 100%);color:#fff;font-size:15px;font-weight:900;cursor:pointer;box-shadow:0 6px 20px rgba(79,70,229,0.35)}
    .btn-submit-main:disabled{opacity:0.65;cursor:not-allowed}
    .bottom-support-banner{width:100%;max-width:960px;background:#fff;border:1.5px solid var(--border-soft);border-radius:24px;padding:22px;display:grid;grid-template-columns:1fr;gap:16px;align-items:center;box-shadow:var(--shadow-elevated)}
    @media(min-width:768px){.bottom-support-banner{grid-template-columns:1.5fr 1fr}}
    .support-perks{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}
    .s-perk{font-size:12px;font-weight:800;color:#334155}
    .floating-3d-graphic{height:115px;display:flex;align-items:center;justify-content:center;position:relative}
    .support-phone-mock{width:85px;height:112px;background:#0f172a;border:2.5px solid var(--brand-purple);border-radius:16px;display:flex;align-items:center;justify-content:center}
    .phone-check{width:34px;height:34px;border-radius:50%;background:#10b981;display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:900}
    .floating-coin{position:absolute;font-size:18px}
    .page-footer{width:100%;max-width:960px;display:flex;justify-content:space-between;align-items:center;margin-top:18px;padding:10px 6px;font-size:11.5px;color:#94a3b8;flex-wrap:wrap;gap:10px}
    .footer-links{display:flex;gap:14px}
    .footer-links a{color:#818cf8;text-decoration:none;font-weight:700}
    .modal-bg{position:fixed;inset:0;background:rgba(15,23,42,0.78);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:16px;z-index:99999}
    .verify-dashboard-box,.success-dashboard-box,.fail-dashboard-box{background:#fff;color:#0f172a;border-radius:26px;width:100%;max-width:430px;padding:24px 20px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.35)}
    .radar-scan-anim{width:68px;height:68px;border-radius:50%;background:#e0e7ff;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;position:relative}
    .pulse-ring{position:absolute;inset:0;border-radius:50%;border:2px solid var(--brand-purple);animation:radarRing 1.4s infinite ease-out}
    @keyframes radarRing{0%{transform:scale(0.8);opacity:1}100%{transform:scale(1.5);opacity:0}}
    .verify-progress-bar-wrap{width:100%;height:8px;background:#e2e8f0;border-radius:20px;overflow:hidden;margin:12px 0}
    .verify-progress-bar{height:100%;width:0%;background:linear-gradient(90deg,#4f46e5,#06b6d4);transition:width 0.9s linear}
    .receipt-details-list{background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:16px;padding:12px;margin:14px 0;text-align:left;font-size:12px}
    .r-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #cbd5e1}
    .r-row:last-child{border-bottom:none}
    .troubleshoot-guide{background:#fff1f2;border:1px dashed #f43f5e;border-radius:14px;padding:11px;margin:12px 0;text-align:left;font-size:11.5px;color:#9f1239;line-height:1.55}
  </style>
</head>
<body>
  <div class="top-navbar">
    <a href="${escapeHtml(redirectUrl)}" class="brand-logo-wrap">
      <div class="brand-logo-icon">TP</div>
      <div class="brand-title"><h2>TOPUPPRO</h2><p>Enterprise Payment Gateway</p></div>
    </a>
    <div class="user-pill">👤 Customer &bull; ৳ ${payableAmount.toFixed(2)}</div>
  </div>

  <div class="payment-master-box">
    <div class="card-header-bar">
      <div class="card-header-title">
        <div class="header-icon-wallet">💳</div>
        <div><h3>Secure Checkout</h3><p>Select Payment Method and Submit Transaction ID</p></div>
      </div>
      <div class="badge-encrypted">🛡️ 100% Encrypted &amp; Safe</div>
    </div>

    <div class="methods-selector-grid">
      ${enabledMethods.map(m => `
        <div class="method-card ${m.key === firstBrand ? "active" : ""}" id="card_${m.key}" onclick="selectPaymentMethod('${m.key}')">
          <div class="active-check">✓</div>
          <div class="method-logo-img"><img src="${escapeHtml(gatewayConfig[m.key].logo)}" alt="${escapeHtml(m.name)}"></div>
          <h4 style="color:${m.color}">${escapeHtml(m.name)}</h4>
          <p>Min ৳${gatewayConfig[m.key].min_amount}</p>
        </div>
      `).join("")}
    </div>

    <div class="payment-split-grid">
      <div class="details-subcard">
        <div class="subcard-title" id="methodDetailsTitle">Payment Details</div>
        <div class="number-display-box">
          <div class="num-info">
            <span id="numberModeBadge">Payment Number (Send Money)</span>
            <b id="activeNumberTxt">---</b>
          </div>
          <button class="btn-copy" onclick="copyPaymentNumber()">📋 Copy</button>
        </div>
        <div class="payment-banner-wrap"><img id="activeBannerImg" src="" alt="Payment Instruction Banner"></div>
        <div class="instruction-box">
          <h5>Payment Instructions:</h5>
          <div class="step-row"><div class="step-circle">1</div><span id="step1Txt">Open Payment App</span></div>
          <div class="step-row"><div class="step-circle">2</div><span>Send <b>৳${payableAmount}</b> to <span id="step2Num">---</span></span></div>
          <div class="step-row"><div class="step-circle">3</div><span id="step3Txt">Enter Transaction ID and Submit</span></div>
        </div>
      </div>

      <div class="trx-subcard">
        <div class="subcard-title">✏️ Enter Transaction ID</div>
        <div class="trx-mode-header">
          <span id="trxBoxLabel" style="color:var(--brand-purple);font-size:12px;font-weight:900">🔑 Transaction ID দিন:</span>
          <button class="btn-paste-unified" onclick="pasteTrxUnified()">📋 Paste</button>
        </div>
        <input type="text" id="trxMainInput" class="trx-main-field" placeholder="Transaction ID লিখুন..." autocomplete="off" spellcheck="false" oninput="onMainTrxInput(this)">

        <div class="statement-card">
          <div class="stmt-head"><span>📋 অ্যাকাউন্ট স্টেটমেন্ট ও সার্ভিস বিবরণ</span><span>${escapeHtml(supportPin)}</span></div>
          ${isDirectOrder ? `
            <div class="stmt-row"><span>সার্ভিসের ধরন:</span><b style="color:#7c3aed">🎮 সরাসরি গেমিং অর্ডার</b></div>
            <div class="stmt-row"><span>গেমের নাম:</span><b>${safeGameName}</b></div>
            <div class="stmt-row"><span>প্যাকেজ:</span><b style="color:var(--emerald)">${safeProdName}</b></div>
            <div class="stmt-row"><span>প্লেয়ার আইডি (UID):</span><b style="color:#0284c7">${safePlayerId}</b></div>
            <div class="stmt-row"><span>ওয়ালেট ব্যালেন্স:</span><b>৳ ${userCurrentBal.toFixed(2)} (অপরিবর্তিত)</b></div>
          ` : `
            <div class="stmt-row"><span>সার্ভিসের ধরন:</span><b style="color:var(--emerald)">💳 ওয়ালেট ব্যালেন্স রিচার্জ</b></div>
            <div class="stmt-row"><span>পূর্বের ব্যালেন্স (Before):</span><b>৳ ${userCurrentBal.toFixed(2)}</b></div>
            <div class="stmt-row"><span>যোগ হচ্ছে (Adding):</span><b style="color:var(--brand-purple)">+ ৳ ${payableAmount.toFixed(2)}</b></div>
            <div class="stmt-row"><span>পরবর্তী মোট ব্যালেন্স (After):</span><b style="color:var(--emerald)">৳ ${userAfterBal.toFixed(2)}</b></div>
          `}
        </div>

        <div class="meta-stats-strip">
          <div><span>Time Left</span><b id="timerClock" style="color:var(--danger)">14:59</b></div>
          <div><span>Invoice ID</span><b style="color:var(--brand-purple)">${escapeHtml(displayInvoice)}</b></div>
        </div>

        <button class="btn-submit-main" id="btnSubmitTrx" onclick="submitTransactionVerification()">✈️ Submit Payment ➔</button>
      </div>
    </div>
  </div>

  <div class="bottom-support-banner">
    <div>
      <h2 style="font-size:19px;font-weight:900">24/7 Live Customer <span style="color:var(--brand-purple)">Support</span></h2>
      <p style="font-size:12px;color:var(--text-muted);margin-top:4px">পেমেন্ট সংক্রান্ত যেকোনো সহায়তায় আমাদের সাপোর্ট টিম সার্বক্ষণিক প্রস্তুত।</p>
      <div class="support-perks">
        <div class="s-perk">⚡ Instant Automated Verification</div>
        <div class="s-perk">🔒 Bank Level Encryption</div>
        <div class="s-perk">🎧 WhatsApp &amp; Telegram Support</div>
        <div class="s-perk">🛡️ 100% Anti-Fraud Protection</div>
      </div>
    </div>
    <div class="floating-3d-graphic">
      <div class="floating-coin" style="top:10px;left:30px">🪙</div>
      <div class="floating-coin" style="bottom:15px;right:35px">🪙</div>
      <div class="support-phone-mock"><div class="phone-check">✓</div></div>
    </div>
  </div>

  <div class="page-footer">
    <div>&copy; 2026 TOPUPPRO. Fast &bull; Secure &bull; Reliable.</div>
    <div class="footer-links">
      <a href="${escapeHtml(redirectUrl)}">About Us</a>
      <a href="${escapeHtml(redirectUrl)}">Privacy Policy</a>
      <a href="${escapeHtml(redirectUrl)}">Terms</a>
      <a href="${escapeHtml(redirectUrl)}">Contact</a>
    </div>
  </div>

  <!-- ১০ সেকেন্ডের ভেরিফিকেশন মোডাল -->
  <div class="modal-bg" id="verifyingModal">
    <div class="verify-dashboard-box" style="border:2px solid var(--brand-purple)">
      <div class="radar-scan-anim"><div class="pulse-ring"></div><span style="font-size:28px">⚡</span></div>
      <h3 style="font-size:18px;font-weight:900">যাচাই করা হচ্ছে...</h3>
      <div style="font-family:'JetBrains Mono';font-size:26px;font-weight:900;color:var(--brand-purple);margin:6px 0"><span id="verifyCountdownNum">10</span>s</div>
      <div class="verify-progress-bar-wrap"><div class="verify-progress-bar" id="verifyProgressBar"></div></div>
      <div id="verifyStepLog" style="font-size:12px;font-weight:700;color:#64748b">ডাটাবেজে TrxID ও SMS হিস্ট্রি স্ক্যান করা হচ্ছে...</div>
    </div>
  </div>

  <!-- পেন্ডিং মোডাল (SMS দেরিতে এলে অটো-পোলিং করে Success দেখাবে) -->
  <div class="modal-bg" id="pendingModal">
    <div class="verify-dashboard-box" style="border:2px solid #f59e0b">
      <div style="font-size:44px;margin-bottom:8px">⏳</div>
      <h2 style="font-size:19px;font-weight:900">Payment Under Verification</h2>
      <p style="font-size:12.5px;color:#64748b;margin-top:4px">Your payment is being verified. Please wait for confirmation.</p>
      <div class="receipt-details-list">
        <div class="r-row"><span>ইনভয়েস আইডি:</span><b>${escapeHtml(displayInvoice)}</b></div>
        <div class="r-row"><span>প্রদত্ত TrxID:</span><b id="pendTrx">---</b></div>
        <div class="r-row"><span>স্ট্যাটাস:</span><b style="color:#d97706">PENDING (Auto Checking...)</b></div>
      </div>
      <button class="btn-submit-main" onclick="document.getElementById('pendingModal').style.display='none'">ঠিক আছে &bull; অপেক্ষা করুন</button>
    </div>
  </div>

  <!-- সাকসেস মোডাল -->
  <div class="modal-bg" id="successModal">
    <div class="success-dashboard-box" style="border:2px solid #10b981">
      <div style="width:64px;height:64px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:28px;color:#059669">✓</div>
      <h2 style="font-size:20px;font-weight:900">Payment Successful!</h2>
      <p id="resSuccessMsg" style="font-size:12px;color:#64748b;margin-top:4px">${isDirectOrder ? "আপনার গেম অর্ডারটি প্রসেসিং শুরু হয়েছে।" : "Your balance has been added successfully."}</p>
      <div class="receipt-details-list">
        <div class="r-row"><span>Transaction ID:</span><b id="resTrx" style="color:#0284c7">N/A</b></div>
        <div class="r-row"><span>Payment Amount:</span><b style="color:#10b981">৳ ${payableAmount.toFixed(2)}</b></div>
        <div class="r-row"><span>Payment Method:</span><b id="resMethod">bKash</b></div>
        <div class="r-row"><span>Invoice ID:</span><b>${escapeHtml(displayInvoice)}</b></div>
        ${!isDirectOrder
          ? `<div class="r-row"><span>Updated Balance:</span><b id="resBal" style="color:var(--emerald)">৳ ${userAfterBal.toFixed(2)}</b></div>`
          : `<div class="r-row"><span>প্লেয়ার আইডি:</span><b>${safePlayerId}</b></div>`}
        <div class="r-row"><span>Success Time:</span><b id="resTime">---</b></div>
      </div>
      <button class="btn-submit-main" style="background:linear-gradient(135deg,#10b981,#059669)" onclick="window.location.href=redirectTarget">ঠিক আছে &bull; ড্যাশবোর্ডে যান ➔</button>
    </div>
  </div>

  <!-- ফেইল মোডাল -->
  <div class="modal-bg" id="failModal">
    <div class="fail-dashboard-box" style="border:2px solid #ef4444">
      <div style="width:64px;height:64px;border-radius:50%;background:#fee2e2;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:28px;color:#dc2626">✕</div>
      <h2 style="font-size:19px;font-weight:900">Payment Failed!</h2>
      <p id="failReasonTxt" style="font-size:12.5px;color:#dc2626;font-weight:800;margin-top:4px">Your transaction could not be verified. Please check your Transaction ID and try again.</p>
      <div class="troubleshoot-guide">
        <b>⚠️ যেভাবে সমাধান করবেন:</b><br>
        ১. আপনি যে মাধ্যমে টাকা পাঠিয়েছেন ঠিক সেই মাধ্যমটি সিলেক্ট করুন।<br>
        ২. আপনার ফিরতি ব্যাংক SMS থেকে Transaction ID হুবহু মিলিয়ে বসান।<br>
        ৩. টাকা পাঠানোর পর ১-২ মিনিট অপেক্ষা করে আবার চেষ্টা করুন।
      </div>
      <div class="receipt-details-list" style="margin-top:0">
        <div class="r-row"><span>প্রদত্ত TrxID:</span><b id="failEnteredTrx" style="color:#dc2626">N/A</b></div>
        <div class="r-row"><span>মেথড:</span><b id="failMethod">---</b></div>
        <div class="r-row"><span>প্রত্যাশিত পরিমাণ:</span><b>৳ ${payableAmount.toFixed(2)}</b></div>
      </div>
      <button class="btn-submit-main" style="background:linear-gradient(135deg,#ef4444,#dc2626)" onclick="closeFailModal()">পুনরায় সঠিক TrxID দিন 🔄</button>
    </div>
  </div>

  <script>
    const invoiceId = "${escapeHtml(invoice_id)}";
    const invoiceAmount = ${payableAmount};
    let isInvoicePaidAlready = ${isAlreadyPaid ? "true" : "false"};
    let redirectTarget = "${escapeHtml(redirectUrl)}";
    let currentBrand = "${escapeHtml(firstBrand)}";
    let isSubmitting = false;
    let successShown = false;
    let pollTimer = null;
    const gateways = ${JSON.stringify(gatewayConfig)};

    let audioCtx = null;
    function getAudioContext() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    }
    function playTone(freqs, type) {
      try {
        const ctx = getAudioContext(), now = ctx.currentTime;
        freqs.forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain();
          osc.type = type || "triangle";
          osc.frequency.setValueAtTime(freq, now + i * 0.08);
          gain.gain.setValueAtTime(0.16, now + i * 0.08);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.25);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now + i * 0.08); osc.stop(now + i * 0.08 + 0.25);
        });
      } catch {}
    }

    function onMainTrxInput(el) { el.value = el.value.toUpperCase(); }

    function getSvgBanner(brand, type, color) {
      const title = (type || "Send Money").toUpperCase();
      return "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="132" viewBox="0 0 360 132"><rect width="360" height="132" rx="14" fill="' + (color || "#4F46E5") + '"/><circle cx="310" cy="30" r="50" fill="rgba(255,255,255,0.12)"/><text x="20" y="45" font-family="sans-serif" font-size="11" font-weight="700" fill="rgba(255,255,255,0.88)">TOPUPPRO OFFICIAL PAYMENT</text><text x="20" y="82" font-family="sans-serif" font-size="24" font-weight="900" fill="#FFFFFF">' + title + '</text><text x="20" y="110" font-family="sans-serif" font-size="12" font-weight="600" fill="#E2E8F0">নিচের নম্বরে ' + title + ' করে TrxID দিন</text></svg>');
    }

    function selectPaymentMethod(brand) {
      currentBrand = brand;
      document.querySelectorAll(".method-card").forEach(el => el.classList.remove("active"));
      document.getElementById("card_" + brand)?.classList.add("active");
      const cfg = gateways[brand] || {};
      const bName = cfg.name || brand.toUpperCase();
      document.getElementById("methodDetailsTitle").innerText = bName + " Payment Details";
      document.getElementById("activeNumberTxt").innerText = cfg.number || "N/A";
      document.getElementById("step2Num").innerText = cfg.number || "N/A";
      document.getElementById("step1Txt").innerText = "Open " + bName + " App";
      document.getElementById("step3Txt").innerText = cfg.desc || "Enter Transaction ID and Submit";
      document.getElementById("numberModeBadge").innerText = (cfg.type || "Send Money") + " (Min ৳" + cfg.min_amount + " - Max ৳" + cfg.max_amount + ")";
      document.getElementById("activeBannerImg").src = cfg.type_img || getSvgBanner(brand, cfg.type, cfg.color);
      document.getElementById("trxBoxLabel").innerText = "🔑 " + bName + " TrxID দিন:";
    }
    selectPaymentMethod(currentBrand);

    function copyPaymentNumber() {
      const num = document.getElementById("activeNumberTxt").innerText.trim();
      playTone([587.33, 880], "sine");
      navigator.clipboard.writeText(num).then(() => alert("📋 পেমেন্ট নম্বর কপি হয়েছে: " + num));
    }

    async function pasteTrxUnified() {
      try {
        document.getElementById("trxMainInput").value = (await navigator.clipboard.readText()).trim().toUpperCase();
      } catch {
        const p = prompt("TrxID বা গিফট কোড লিখুন:");
        if (p) document.getElementById("trxMainInput").value = p.trim().toUpperCase();
      }
    }

    let timeLeft = 899;
    setInterval(() => {
      if (timeLeft <= 0) return;
      timeLeft--;
      const m = Math.floor(timeLeft / 60), s = timeLeft % 60;
      document.getElementById("timerClock").innerText = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }, 1000);

    function showSuccessDashboard(trx, methodName, updatedBal, verifiedAt) {
      if (successShown) return;
      successShown = true;
      clearInterval(pollTimer);
      document.getElementById("verifyingModal").style.display = "none";
      document.getElementById("pendingModal").style.display = "none";
      document.getElementById("resMethod").innerText = (methodName || currentBrand).toUpperCase();
      document.getElementById("resTrx").innerText = trx;
      const balEl = document.getElementById("resBal");
      if (balEl && updatedBal != null) balEl.innerText = "৳ " + Number(updatedBal).toFixed(2);
      document.getElementById("resTime").innerText = new Date(verifiedAt || Date.now()).toLocaleString("bn-BD");
      playTone([523.25, 659.25, 783.99, 1046.50], "triangle");
      document.getElementById("successModal").style.display = "flex";
    }

    function showFailDashboard(trx, reason) {
      document.getElementById("failEnteredTrx").innerText = trx;
      document.getElementById("failMethod").innerText = currentBrand.toUpperCase();
      document.getElementById("failReasonTxt").innerText = reason;
      playTone([350, 260], "sawtooth");
      document.getElementById("failModal").style.display = "flex";
    }

    function closeFailModal() {
      document.getElementById("failModal").style.display = "none";
      document.getElementById("trxMainInput")?.focus();
    }

    function startPendingPolling() {
      clearInterval(pollTimer);
      if (!invoiceId) return;
      pollTimer = setInterval(async () => {
        try {
          const st = await fetch("/api/check-status?invoice_id=" + encodeURIComponent(invoiceId)).then(r => r.json());
          if (st.status === "PAID" || st.paymentStatus === "SUCCESS") {
            isInvoicePaidAlready = true;
            if (st.redirect_url) redirectTarget = st.redirect_url;
            showSuccessDashboard(st.trxId || "VERIFIED", st.method || currentBrand, st.updatedBalance, st.paidAt);
          } else if (st.status === "REJECTED" || st.status === "EXPIRED") {
            clearInterval(pollTimer);
            document.getElementById("pendingModal").style.display = "none";
            showFailDashboard(st.trxId || "N/A", "পেমেন্টটি " + st.status + " হয়েছে।");
          }
        } catch {}
      }, 3000);
    }

    async function submitTransactionVerification() {
      if (isSubmitting) return;
      if (isInvoicePaidAlready || successShown) {
        showFailDashboard("N/A", "⚠️ এই ইনভয়েসের পেমেন্ট ইতিমধ্যে সফল হয়েছে! নতুন পেমেন্টের জন্য নতুন অর্ডার তৈরি করুন।");
        return;
      }

      const rawTrx = document.getElementById("trxMainInput").value.trim().toUpperCase();
      const trx = rawTrx.replace(/[^A-Z0-9_]/g, "");
      if (!trx || trx.length < 4) {
        showFailDashboard(rawTrx || "খালি", "দয়া করে সম্পূর্ণ ট্রানজ্যাকশন আইডি (TrxID) বা কোড লিখুন!");
        return;
      }

      // Immediate client format check
      const isBonus = (trx.includes("_") || trx.startsWith("GIFT"));
      if (!isBonus) {
        if (currentBrand === "bkash" && trx.length !== 10) {
          return showFailDashboard(trx, trx.length === 8 ? "❌ এটি নগদের ৮ ডিজিটের TxnID! বিকাশ সিলেক্ট করা আছে।" : "❌ বিকাশ TrxID ঠিক ১০ ডিজিটের (যেমন: BLG789ABCD) হতে হবে!");
        }
        if (currentBrand === "nagad" && trx.length !== 8) {
          return showFailDashboard(trx, trx.length === 10 ? "❌ এটি বিকাশের ১০ ডিজিটের TrxID! নগদ সিলেক্ট করা আছে।" : "❌ নগদ TxnID ঠিক ৮ ডিজিটের (যেমন: 7K89ABCD) হতে হবে!");
        }
        if (currentBrand === "rocket" && !/^[0-9]{9,16}$/.test(trx)) {
          return showFailDashboard(trx, "❌ রকেট TxnId শুধুমাত্র ৯ থেকে ১৬ ডিজিটের সংখ্যা হতে হবে!");
        }
        if (currentBrand === "upay" && !/^[A-Z0-9]{8,14}$/.test(trx)) {
          return showFailDashboard(trx, "❌ উপায় TxnID ৮ থেকে ১৪ অক্ষরের কোড হতে হবে!");
        }
      }

      isSubmitting = true;
      const btn = document.getElementById("btnSubmitTrx");
      btn.disabled = true; btn.innerText = "যাচাই করা হচ্ছে... ⏳";

      const verifyModal = document.getElementById("verifyingModal");
      const countdownNum = document.getElementById("verifyCountdownNum");
      const progressBar = document.getElementById("verifyProgressBar");
      const stepLog = document.getElementById("verifyStepLog");
      verifyModal.style.display = "flex";

      let sec = 10;
      countdownNum.innerText = sec;
      progressBar.style.width = "0%";
      stepLog.innerText = currentBrand.toUpperCase() + " ডাটাবেজে TrxID ও এসএমএস হিস্ট্রি স্ক্যান করা হচ্ছে...";

      let resolvedResp = null;
      const doVerify = () => fetch("/api/verify-trx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: invoiceId, trxid: trx, method: currentBrand, amount: invoiceAmount })
      }).then(r => r.json()).catch(() => ({ status: false, paymentStatus: "FAILED", message: "সার্ভার কানেকশনে সমস্যা হয়েছে।" }));

      doVerify().then(r => { resolvedResp = r; });

      const timer = setInterval(async () => {
        sec--;
        countdownNum.innerText = Math.max(0, sec);
        progressBar.style.width = ((10 - Math.max(0, sec)) / 10) * 100 + "%";

        if (sec === 7) stepLog.innerText = "মেথড ও টাকার অঙ্ক পুঙ্খানুপুঙ্খ যাচাই চলছে...";
        if (sec === 4) {
          stepLog.innerText = "ক্লাউড সার্ভারে লেনদেন চূড়ান্ত অনুমোদন হচ্ছে...";
          // Re-check once midway in case SMS just arrived in ss.html
          if (resolvedResp && resolvedResp.paymentStatus === "PENDING") {
            resolvedResp = await doVerify();
          }
        }
        if (resolvedResp && (resolvedResp.status === true || resolvedResp.paymentStatus === "SUCCESS")) {
          clearInterval(timer);
          btn.disabled = false; btn.innerText = "✈️ Submit Payment ➔"; isSubmitting = false;
          if (resolvedResp.redirect_url) redirectTarget = resolvedResp.redirect_url;
          showSuccessDashboard(trx, resolvedResp.method, resolvedResp.updatedBalance, resolvedResp.verifiedAt);
          return;
        }
        if (sec <= 0) {
          clearInterval(timer);
          verifyModal.style.display = "none";
          btn.disabled = false; btn.innerText = "✈️ Submit Payment ➔"; isSubmitting = false;

          const resp = resolvedResp || await doVerify();
          if (resp && (resp.status === true || resp.paymentStatus === "SUCCESS")) {
            isInvoicePaidAlready = true;
            if (resp.redirect_url) redirectTarget = resp.redirect_url;
            showSuccessDashboard(trx, resp.method, resp.updatedBalance, resp.verifiedAt);
          } else if (resp && resp.paymentStatus === "PENDING") {
            document.getElementById("pendTrx").innerText = trx;
            document.getElementById("pendingModal").style.display = "flex";
            startPendingPolling();
          } else {
            showFailDashboard(trx, (resp && resp.message) || "Your transaction could not be verified. Please check your Transaction ID and try again.");
          }
        }
      }, 1000);
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 TopUpPro 6-Gateway VIP Server listening on port ${PORT}`));
module.exports = app;
