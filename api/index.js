const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_KEY = "LYUNA_LIVE_API_KEY_2026";
const SECRET_KEY = "LYUNA_LIVE_SECRET_9988";
const RTDB_URL = "https://topuppro-4b458-default-rtdb.firebaseio.com";

const invoiceStore = {};

// ১. TopUpPro থেকে পেমেন্ট রিকোয়েস্ট রিসিভ করা
app.post("/api/create-payment", async (req, res) => {
  const { amount, redirect_url, cancel_url } = req.body;
  const invoice_id = "INV_" + Date.now();

  invoiceStore[invoice_id] = {
    invoice_id,
    amount: parseFloat(amount) || 100,
    redirect_url: redirect_url || "https://topuppro.com",
    cancel_url: cancel_url || "https://topuppro.com",
    status: "PENDING"
  };

  const checkout_url = `https://${req.headers.host}/checkout?invoice_id=${invoice_id}`;

  return res.status(200).json({
    status: true,
    message: "Payment Initiated",
    payment_url: checkout_url
  });
});

// ২. প্রিমিয়াম কাস্টমার পেমেন্ট পেজ
app.get("/checkout", async (req, res) => {
  const invoice_id = req.query.invoice_id;
  const invoice = invoiceStore[invoice_id];

  if (!invoice) return res.send("<h3>❌ পেমেন্ট সেশন পাওয়া যায়নি বা মেয়াদ শেষ!</h3>");

  let bkash = "01825760029", nagad = "01825760029", rocket = "01965101494";
  try {
    const numRes = await fetch(`${RTDB_URL}/settings/numbers.json`);
    const numData = await numRes.json();
    if (numData) {
      if (numData.bkash) bkash = numData.bkash;
      if (numData.nagad) nagad = numData.nagad;
      if (numData.rocket) rocket = numData.rocket;
    }
  } catch (e) {}

  res.send(`
  <!DOCTYPE html>
  <html lang="bn">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lyuna Instant Pay</title>
    <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@500;700&display=swap" rel="stylesheet">
    <style>
      *{box-sizing:border-box;margin:0;padding:0;font-family:'Hind Siliguri',sans-serif}
      body{background:#090611;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:15px}
      .card{background:#120b22;border:1px solid #2a1945;border-radius:20px;width:100%;max-width:400px;padding:24px;box-shadow:0 10px 35px rgba(0,0,0,0.7)}
      .title{text-align:center;font-size:20px;font-weight:700;color:#ffb703;margin-bottom:4px}
      .sub{text-align:center;font-size:12px;color:#9d9db5;margin-bottom:16px}
      .amt-box{background:#0e1e1a;border:1px solid #14532d;color:#00f59b;padding:10px;border-radius:12px;text-align:center;font-size:18px;font-weight:700;margin-bottom:15px}
      .methods{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:15px}
      .m-btn{background:#1d1333;border:1px solid #2a1945;color:#fff;padding:10px 5px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;text-align:center}
      .m-btn.active{border-color:#ffb703;background:rgba(255,183,3,0.15);color:#ffb703}
      .num-box{background:#1d1333;border:1px dashed #ffb703;padding:14px;border-radius:12px;text-align:center;margin-bottom:15px}
      .num-val{font-size:22px;font-weight:700;color:#ffb703;letter-spacing:1px;margin:6px 0}
      .copy-btn{background:#fb8500;border:none;color:#fff;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer}
      input{width:100%;background:#090514;border:1px solid #2a1945;padding:12px;border-radius:10px;color:#fff;font-size:15px;margin-bottom:14px;outline:none;text-transform:uppercase}
      input:focus{border-color:#ffb703}
      .btn-submit{width:100%;background:linear-gradient(90deg,#ea580c,#f59e0b);color:#fff;border:none;padding:14px;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer}
      .note{font-size:11px;color:#888;text-align:center;margin-top:12px}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="title">⚡ LYUNA AUTO PAY</div>
      <div class="sub">ইনস্ট্যান্ট পেমেন্ট ভেরিফিকেশন সিস্টেম</div>
      <div class="amt-box">প্রদেয় পরিমাণ: ৳ ${invoice.amount}</div>

      <div class="methods">
        <div class="m-btn active" id="bBkash" onclick="setM('bkash','${bkash}')">📱 বিকাশ</div>
        <div class="m-btn" id="bNagad" onclick="setM('nagad','${nagad}')">📱 নগদ</div>
        <div class="m-btn" id="bRocket" onclick="setM('rocket','${rocket}')">📱 রকেট</div>
      </div>

      <div class="num-box">
        <div style="font-size:12px;color:#9d9db5">নিচের নম্বরে Send Money করুন:</div>
        <div class="num-val" id="numTxt">${bkash}</div>
        <button class="copy-btn" onclick="copyNum()">নম্বর কপি করুন</button>
      </div>

      <form method="POST" action="/api/verify-trx">
        <input type="hidden" name="invoice_id" value="${invoice_id}">
        <label style="font-size:12px;color:#9d9db5;display:block;margin-bottom:6px">SMS-এ পাওয়া TrxID লিখুন:</label>
        <input type="text" name="trxid" placeholder="যেমন: BL9A8BC19D" required>
        <button type="submit" class="btn-submit">ভেরিফাই করে ব্যালেন্স যোগ করুন ⚡</button>
      </form>
      <div class="note">🔒 সঠিক TrxID দিলে ১ সেকেন্ডে অটোমেটিক ব্যালেন্স জমা হবে।</div>
    </div>

    <script>
      let activeNum = "${bkash}";
      function setM(type, num){
        document.querySelectorAll('.m-btn').forEach(b => b.classList.remove('active'));
        if(type==='bkash') document.getElementById('bBkash').classList.add('active');
        if(type==='nagad') document.getElementById('bNagad').classList.add('active');
        if(type==='rocket') document.getElementById('bRocket').classList.add('active');
        document.getElementById('numTxt').innerText = num;
        activeNum = num;
      }
      function copyNum(){
        navigator.clipboard.writeText(activeNum).then(()=>alert("✅ নম্বর কপি হয়েছে: " + activeNum));
      }
    </script>
  </body>
  </html>
  `);
});

// ৩. ট্রানজেকশন যাচাই এবং ব্যালেন্স অনুমোদন
app.post("/api/verify-trx", async (req, res) => {
  const { invoice_id, trxid } = req.body;
  const invoice = invoiceStore[invoice_id];

  if (!invoice) return res.send("<h3>❌ অবৈধ লেনদেন!</h3>");

  const cleanTrx = (trxid || "").toUpperCase().trim();

  let isMatched = false;
  let smsKey = null;

  try {
    const smsRes = await fetch(`${RTDB_URL}/sms_pool.json`);
    const smsData = await smsRes.json();

    if (smsData) {
      for (const key in smsData) {
        const item = smsData[key];
        const rawSms = (item.sms || "").toUpperCase();

        if (rawSms.includes(cleanTrx) && !item.used) {
          if (rawSms.includes(invoice.amount.toString())) {
            isMatched = true;
            smsKey = key;
            break;
          }
        }
      }
    }
  } catch (e) {}

  if (!isMatched) {
    return res.send(`
      <body style="background:#090611;color:#ff3366;font-family:sans-serif;text-align:center;padding:50px">
        <h2>❌ পেমেন্ট মেলেনি!</h2>
        <p style="color:#ccc;margin-top:10px">ভুয়া TrxID অথবা টাকা অ্যাকাউন্টে আসেনি। সঠিক তথ্য দিয়ে আবার চেষ্টা করুন।</p>
        <button onclick="history.back()" style="margin-top:20px;padding:10px 20px;background:#fb8500;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer">পেছনে যান</button>
      </body>
    `);
  }

  // SMS টিকে Used মার্ক করা
  if (smsKey) {
    await fetch(`${RTDB_URL}/sms_pool/${smsKey}.json`, {
      method: "PATCH",
      body: JSON.stringify({ used: true })
    });
  }

  // কাস্টমারকে TopUpPro-তে সফলভাবে ফেরত পাঠানো (অটো ব্যালেন্স যুক্ত হবে)
  const redirectSuccess = `${invoice.redirect_url}?invoice_id=${invoice.invoice_id}&status=COMPLETED&trx_id=${cleanTrx}`;
  return res.redirect(redirectSuccess);
});

module.exports = app;
