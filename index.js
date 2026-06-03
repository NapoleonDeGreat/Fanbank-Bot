const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// In-memory users store: phone -> user object
const users = {};

const CLUBS = {
  '1': { name: 'Arsenal', emoji: '' },
  '2': { name: 'Chelsea', emoji: '' },
  '3': { name: 'Man United', emoji: '' },
  '4': { name: 'Liverpool', emoji: '' },
  '5': { name: 'Barcelona', emoji: '' },
  '6': { name: 'Real Madrid', emoji: '' },
};

function getUser(phone) {
  if (!users[phone]) {
    users[phone] = {
      name: null,
      club: null,
      balance: 5000,
      fansave: 1200,
      xp: 450,
      streak: 3,
      rank: 'Bronze Banter',
      state: null,
      pendingTransfer: null,
    };
  }
  return users[phone];
}

// ─── WhatsApp send helper ────────────────────────────────────────────────────

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('sendMessage error:', err?.response?.data || err.message);
  }
}

// ─── Anchor placeholder ──────────────────────────────────────────────────────

async function anchorTransfer(amount, accountNumber, bankName) {
  console.log(`[Anchor] Transfer ₦${amount} to ${accountNumber} at ${bankName}`);
  // Replace with real Anchor API call
  return { success: true };
}

// ─── VTPass placeholder ──────────────────────────────────────────────────────

async function vtpassAirtime(phone, amount) {
  console.log(`[VTPass] Airtime ₦${amount} to ${phone}`);
  // Replace with real VTPass API call
  return { success: true };
}

// ─── Claude: banter receipt ──────────────────────────────────────────────────

async function claudeGenerateBanterReceipt(senderClub, amount, accountNumber, bankName) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 150,
    system:
      'You are FanBank banter generator. Generate ONE short savage football banter receipt message maximum 3 sentences. Use Nigerian expressions. Be funny. Reference the sender club vs receiver. Never make up transaction details — those are handled separately. Just write the banter text only.',
    messages: [
      {
        role: 'user',
        content: `Sender supports ${senderClub || 'an unknown club'}. They just sent ₦${amount} to account ${accountNumber} at ${bankName}. Write the banter receipt.`,
      },
    ],
  });
  return message.content[0].text;
}

// ─── Claude: general chat ────────────────────────────────────────────────────

async function claudeRespond(phone, text) {
  const user = getUser(phone);
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    system:
      'You are FanBank AI assistant for the World\'s First Banter Neo Gaming Bank. You speak like a witty Nigerian football fan. Use Nigerian expressions naturally. You help users understand FanBank features. You NEVER confirm transactions, NEVER quote balances, NEVER process payments — tell users to type SEND for transfers, BAL for balance, BUY AIRTIME for airtime. You only chat, explain features, and generate banter. Keep responses short for WhatsApp.',
    messages: [
      {
        role: 'user',
        content: text,
      },
    ],
  });
  const reply = message.content[0].text;
  await sendMessage(phone, reply);
}

// ─── Flow handlers ───────────────────────────────────────────────────────────

async function showWelcome(phone) {
  const msg =
    'Welcome to FanBank — World\'s First Banter Neo Gaming Bank!\n\n' +
    'Choose your club to get started:\n\n' +
    '1️⃣  Arsenal\n' +
    '2️⃣  Chelsea\n' +
    '3️⃣  Man United\n' +
    '4️⃣  Liverpool\n' +
    '5️⃣  Barcelona\n' +
    '6️⃣  Real Madrid\n\n' +
    'Reply with the number of your club!';
  await sendMessage(phone, msg);
}

async function selectClub(phone, choice) {
  const user = getUser(phone);
  const club = CLUBS[choice];
  user.club = club.name;
  await sendMessage(
    phone,
    `${club.emoji} Oya! You are now a proud ${club.name} fan on FanBank!\n\nYour banter journey don begin! Type BAL to see your wallet, SEND to transfer money, or BUY AIRTIME for airtime.`
  );
}

async function showBalance(phone) {
  const user = getUser(phone);
  const club = user.club ? `${user.club} fan` : 'FanBank member';
  const msg =
    `📊 *FanBank Wallet — ${club}*\n\n` +
    `💰 Wallet Balance: ₦${user.balance.toLocaleString()}\n` +
    `🐷 FanSave Pot: ₦${user.fansave.toLocaleString()}\n` +
    `⚡ XP: ${user.xp}\n` +
    `🔥 Streak: ${user.streak} days\n` +
    `🏅 Rank: ${user.rank}`;
  await sendMessage(phone, msg);
}

async function executeTransfer(phone, raw) {
  const user = getUser(phone);
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 3) {
    await sendMessage(
      phone,
      'Format no correct o! Send like this:\n\nAMOUNT | ACCOUNT_NUMBER | BANK_NAME\n\nExample: 5000 | 0123456789 | GTBank'
    );
    return;
  }
  const [amountStr, accountNumber, bankName] = parts;
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || amount <= 0) {
    await sendMessage(phone, 'Amount no valid o! Enter correct number abeg.');
    return;
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    await sendMessage(phone, 'Account number must be exactly 10 digits! Check and try again.');
    return;
  }

  user.state = null;
  user.pendingTransfer = null;

  const result = await anchorTransfer(amount, accountNumber, bankName);
  if (result.success) {
    user.balance = Math.max(0, user.balance - amount);
    user.xp += 50;
    const banter = await claudeGenerateBanterReceipt(user.club, amount, accountNumber, bankName);
    await sendMessage(
      phone,
      `✅ *Transfer Successful!*\n\n` +
        `Amount: ₦${amount.toLocaleString()}\n` +
        `Account: ${accountNumber}\n` +
        `Bank: ${bankName}\n\n` +
        `🎭 *Banter Receipt:*\n${banter}\n\n` +
        `+50 XP earned!`
    );
  } else {
    await sendMessage(
      phone,
      `Transfer failed! Something went wrong on our end. Please try again or contact support.`
    );
  }
}

async function executeAirtime(phone, raw) {
  const user = getUser(phone);
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 2) {
    await sendMessage(
      phone,
      'Format no correct! Send like this:\n\nPHONE_NUMBER | AMOUNT\n\nExample: 08012345678 | 500'
    );
    return;
  }
  const [airtimePhone, amountStr] = parts;
  const amount = parseFloat(amountStr);

  if (!/^\d{11}$/.test(airtimePhone)) {
    await sendMessage(phone, 'Phone number must be 11 digits! Check and try again.');
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    await sendMessage(phone, 'Amount no valid! Enter correct number abeg.');
    return;
  }

  user.state = null;

  const result = await vtpassAirtime(airtimePhone, amount);
  if (result.success) {
    user.balance = Math.max(0, user.balance - amount);
    user.xp += 20;
    await sendMessage(
      phone,
      `✅ *Airtime Sent!*\n\nPhone: ${airtimePhone}\nAmount: ₦${amount.toLocaleString()}\n\n+20 XP earned! Na you baddest!`
    );
  } else {
    await sendMessage(
      phone,
      `Airtime purchase failed! Try again or contact support.`
    );
  }
}

// ─── Main message handler ────────────────────────────────────────────────────

async function handleMessage(phone, text) {
  const user = getUser(phone);
  const lower = text.toLowerCase().trim();

  // Greeting / start
  if (lower === 'hi' || lower === 'hello' || lower === 'start') {
    return showWelcome(phone);
  }

  // Club selection (1–6)
  if (/^[1-6]$/.test(lower) && CLUBS[lower]) {
    return selectClub(phone, lower);
  }

  // Balance
  if (lower === 'bal' || lower === 'balance') {
    return showBalance(phone);
  }

  // Transfer intent
  if (lower.includes('send') || lower.includes('transfer')) {
    user.state = 'TRANSFER';
    return sendMessage(
      phone,
      'Okay! Who you wan send money to?\n\nReply with:\nAMOUNT | ACCOUNT_NUMBER | BANK_NAME\n\nExample:\n5000 | 0123456789 | GTBank'
    );
  }

  // Airtime intent
  if (lower.includes('buy airtime')) {
    user.state = 'AIRTIME';
    return sendMessage(
      phone,
      'No wahala! Which number and how much?\n\nReply with:\nPHONE_NUMBER | AMOUNT\n\nExample:\n08012345678 | 500'
    );
  }

  // Transfer execution: amount | account | bank while in TRANSFER state
  if (user.state === 'TRANSFER' && /\|/.test(text)) {
    return executeTransfer(phone, text);
  }

  // Airtime execution: phone | amount while in AIRTIME state
  if (user.state === 'AIRTIME' && /\|/.test(text)) {
    return executeAirtime(phone, text);
  }

  // Fallback: Claude general chat
  return claudeRespond(phone, text);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text = message?.text?.body;

    if (!from || !text) return;

    console.log(`[MSG] from=${from} text="${text}"`);
    await handleMessage(from, text);
  } catch (err) {
    console.error('POST /webhook error:', err.message);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`FanBank webhook server running on port ${PORT}`);
});
