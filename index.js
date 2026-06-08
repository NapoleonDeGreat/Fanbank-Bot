const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const FormData = require('form-data');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
  { realtime: { transport: WebSocket } }
);

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ─── In-memory cache (write-through to Supabase) ─────────────────────────────

const userCache = {};

async function getUser(phone) {
  if (userCache[phone]) return userCache[phone];

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .single();

  if (data) {
    const user = {
      name: data.name,
      club: data.club,
      clubData: data.club
        ? { name: data.club, emoji: data.club_emoji, colors: data.club_colors, rival: data.club_rival }
        : null,
      balance: data.balance,
      fansave: data.fansave,
      xp: data.xp,
      streak: data.streak,
      rank: data.rank,
      state: data.state,
      pendingTransfer: data.pending_transfer,
      anchorCustomerId: data.anchor_customer_id,
      anchorAccountNumber: data.anchor_account_number,
      anchorBankName: data.anchor_bank_name,
    };
    userCache[phone] = user;
    return user;
  }

  const defaultUser = {
    name: null, club: null, clubData: null,
    balance: 5000, fansave: 1200, xp: 450,
    streak: 3, rank: 'Bronze Banter',
    state: null, pendingTransfer: null,
    anchorCustomerId: null, anchorAccountNumber: null, anchorBankName: null,
  };

  await supabase.from('users').insert({ phone });
  userCache[phone] = defaultUser;
  return defaultUser;
}

async function saveUser(phone, user) {
  userCache[phone] = user;
  await supabase.from('users').upsert({
    phone,
    name: user.name,
    club: user.club,
    club_emoji: user.clubData?.emoji || null,
    club_colors: user.clubData?.colors || null,
    club_rival: user.clubData?.rival || null,
    balance: user.balance,
    fansave: user.fansave,
    xp: user.xp,
    streak: user.streak,
    rank: user.rank,
    state: user.state,
    pending_transfer: user.pendingTransfer,
    anchor_customer_id: user.anchorCustomerId,
    anchor_account_number: user.anchorAccountNumber,
    anchor_bank_name: user.anchorBankName,
    updated_at: new Date().toISOString(),
  });
}

// ─── Amount parser (supports 15k → 15000, 1.5k → 1500) ──────────────────────

function parseAmount(str) {
  const cleaned = String(str).trim().toLowerCase().replace(/,/g, '');
  if (cleaned.endsWith('k')) {
    return parseFloat(cleaned.slice(0, -1)) * 1000;
  }
  return parseFloat(cleaned);
}

// ─── Club colours for welcome image ──────────────────────────────────────────

const CLUB_COLORS = {
  'Arsenal':    { bg: '#DB0007', text: '#FFFFFF' },
  'Chelsea':    { bg: '#034694', text: '#FFFFFF' },
  'Man United': { bg: '#DA291C', text: '#FFE500' },
  'Liverpool':  { bg: '#C8102E', text: '#00B2A9' },
  'Barcelona':  { bg: '#004D98', text: '#FFFFFF' },
  'Real Madrid':{ bg: '#FEBE10', text: '#00529F' },
};

const CLUBS = {
  '1': { name: 'Arsenal',    emoji: '🔴', colors: '🔴⚪', rival: 'Tottenham'   },
  '2': { name: 'Chelsea',    emoji: '🔵', colors: '🔵⚪', rival: 'Arsenal'     },
  '3': { name: 'Man United', emoji: '🔴', colors: '🔴⚫', rival: 'Man City'   },
  '4': { name: 'Liverpool',  emoji: '🔴', colors: '🔴⚪', rival: 'Everton'    },
  '5': { name: 'Barcelona',  emoji: '🔵', colors: '🔵🔴', rival: 'Real Madrid' },
  '6': { name: 'Real Madrid',emoji: '⚪', colors: '⚪🟡', rival: 'Barcelona'  },
};

// ─── Typing indicator ────────────────────────────────────────────────────────

async function sendTyping(to, messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendTyping error:', err?.response?.data || err.message);
  }
}

// ─── WhatsApp text helper ────────────────────────────────────────────────────

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendMessage error:', err?.response?.data || err.message);
  }
}

// ─── WhatsApp audio forward ──────────────────────────────────────────────────

async function sendAudio(to, audioId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: audioId } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendAudio error:', err?.response?.data || err.message);
  }
}

// ─── WhatsApp image sender ───────────────────────────────────────────────────

async function sendImageBuffer(to, imageBuffer, caption = '') {
  try {
    const form = new FormData();
    form.append('file', imageBuffer, { filename: 'welcome.png', contentType: 'image/png' });
    form.append('type', 'image/png');
    form.append('messaging_product', 'whatsapp');

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`,
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );

    const mediaId = uploadRes.data.id;

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendImageBuffer error:', err?.response?.data || err.message);
  }
}

// ─── Welcome image generator ─────────────────────────────────────────────────

async function generateWelcomeImage(name, accountNumber, clubName) {
  const { bg, text } = CLUB_COLORS[clubName] || { bg: '#1a1a2e', text: '#FFFFFF' };
  const svg = Buffer.from(`<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg">
    <rect width="800" height="450" fill="${bg}"/>
    <rect x="0" y="0" width="800" height="8" fill="${text}" opacity="0.4"/>
    <rect x="0" y="442" width="800" height="8" fill="${text}" opacity="0.4"/>
    <text x="400" y="100" text-anchor="middle" fill="${text}" font-size="56" font-weight="bold" font-family="Arial, sans-serif">FanBank</text>
    <text x="400" y="145" text-anchor="middle" fill="${text}" font-size="18" font-family="Arial, sans-serif" opacity="0.85">World's First Banter Neo Gaming Bank</text>
    <line x1="80" y1="175" x2="720" y2="175" stroke="${text}" stroke-width="1" opacity="0.3"/>
    <text x="400" y="240" text-anchor="middle" fill="${text}" font-size="36" font-family="Arial, sans-serif">Welcome, ${name}!</text>
    <text x="400" y="295" text-anchor="middle" fill="${text}" font-size="22" font-family="Arial, sans-serif" opacity="0.85">Virtual Account Number</text>
    <text x="400" y="345" text-anchor="middle" fill="${text}" font-size="38" font-weight="bold" font-family="Arial, sans-serif">${accountNumber}</text>
    <text x="400" y="410" text-anchor="middle" fill="${text}" font-size="20" font-family="Arial, sans-serif" opacity="0.75">${clubName} Fan 🏟️</text>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

// ─── Anchor: create customer + deposit account ────────────────────────────────

async function createAnchorAccount(phone, name, bvn) {
  const e164 = phone.startsWith('234') ? '+' + phone : phone;

  const customerRes = await axios.post(
    'https://api.sandbox.getanchor.co/api/v1/customers',
    {
      data: {
        type: 'IndividualCustomer',
        attributes: { fullName: name, phoneNumber: e164, bvn }
      }
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'x-anchor-key': process.env.ANCHOR_API_KEY
      }
    }
  );

  const customerId = customerRes.data?.data?.id;
  if (!customerId) throw new Error('No customer ID from Anchor');

  const accountRes = await axios.post(
    'https://api.sandbox.getanchor.co/api/v1/deposit-accounts',
    {
      data: {
        type: 'DepositAccount',
        attributes: { productName: 'SAVING', currency: 'NGN' },
        relationships: {
          customer: { data: { type: 'IndividualCustomer', id: customerId } }
        }
      }
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'x-anchor-key': process.env.ANCHOR_API_KEY
      }
    }
  );

  const attrs = accountRes.data?.data?.attributes;
  const accountNumber = attrs?.accountNumber;
  const bankName = attrs?.bankName || 'Anchor Bank';

  return { customerId, accountNumber, bankName };
}

// ─── Anchor: transfer ────────────────────────────────────────────────────────

const BANK_CODES = {
  'opay': '100004', 'gtbank': '000013', 'gtb': '000013',
  'access': '000014', 'zenith': '000015', 'uba': '000004',
  'first bank': '000016', 'firstbank': '000016', 'kuda': '090267',
  'palmpay': '100033', 'moniepoint': '090405', 'wema': '000017',
  'stanbic': '000012', 'union': '000018', 'sterling': '000001',
  'providus': '000023', 'fidelity': '000007',
};

async function anchorTransfer(amount, accountNumber, bankName) {
  try {
    const bankCode = BANK_CODES[bankName.toLowerCase()] || bankName;

    const cpRes = await axios.post(
      'https://api.sandbox.getanchor.co/api/v1/counterparties',
      {
        data: {
          type: 'CounterParty',
          attributes: { accountName: 'FanBank User', accountNumber, bankCode }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'accept': 'application/json',
          'x-anchor-key': process.env.ANCHOR_API_KEY
        }
      }
    );

    const counterpartyId = cpRes.data?.data?.id;
    if (!counterpartyId) throw new Error('No counterparty ID returned');

    const transferRes = await axios.post(
      'https://api.sandbox.getanchor.co/api/v1/transfers',
      {
        data: {
          type: 'NIPTransfer',
          attributes: {
            amount: amount * 100,
            currency: 'NGN',
            reason: 'FanBank Transfer',
            reference: 'fanbank_' + Date.now()
          },
          relationships: {
            counterParty: { data: { type: 'CounterParty', id: counterpartyId } },
            account: { data: { type: 'DepositAccount', id: process.env.ANCHOR_FBO_ACCOUNT_ID } }
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'accept': 'application/json',
          'x-anchor-key': process.env.ANCHOR_API_KEY
        }
      }
    );

    return { success: true, data: transferRes.data };
  } catch (err) {
    console.error('Anchor transfer error:', err?.response?.data || err.message);
    return { success: false, error: err?.response?.data };
  }
}

// ─── VTPass placeholder ──────────────────────────────────────────────────────

async function vtpassAirtime(phone, amount) {
  console.log(`[VTPass] Airtime ₦${amount} to ${phone}`);
  return { success: true };
}

// ─── Claude: banter receipt ──────────────────────────────────────────────────

async function claudeGenerateBanterReceipt(senderClub, clubData, amount, accountNumber, bankName) {
  const rival = clubData?.rival || 'their rival';
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 150,
    system: `You are FanBank banter generator. Generate ONE short savage football banter receipt message maximum 3 sentences. Use Nigerian expressions. You are a LOYAL fan of ${senderClub} — NEVER mock ${senderClub}. Savage their rival ${rival} mercilessly. Hype up the sender for being a ${senderClub} legend. Never make up transaction details. Just write the banter text only.`,
    messages: [{
      role: 'user',
      content: `Sender supports ${senderClub || 'unknown club'} (rival: ${rival}). They just sent ₦${amount} to account ${accountNumber} at ${bankName}. Write the savage banter receipt.`,
    }],
  });
  return message.content[0].text;
}

// ─── Claude: general chat ────────────────────────────────────────────────────

async function claudeRespond(phone, text) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    system: 'You are FanBank AI assistant for the World\'s First Banter Neo Gaming Bank. You speak like a witty Nigerian football fan. Use Nigerian expressions naturally. You help users understand FanBank features. You NEVER confirm transactions, NEVER quote balances, NEVER process payments — tell users to type SEND for transfers, BAL for balance, BUY AIRTIME for airtime. You only chat, explain features, and generate banter. Keep responses short for WhatsApp.',
    messages: [{ role: 'user', content: text }],
  });
  await sendMessage(phone, message.content[0].text);
}

// ─── Flow handlers ───────────────────────────────────────────────────────────

async function showWelcome(phone) {
  await sendMessage(
    phone,
    'Welcome to FanBank — World\'s First Banter Neo Gaming Bank!\n\nChoose your club to get started:\n\n1️⃣  Arsenal\n2️⃣  Chelsea\n3️⃣  Man United\n4️⃣  Liverpool\n5️⃣  Barcelona\n6️⃣  Real Madrid\n\nReply with the number of your club!'
  );
}

async function selectClub(phone, choice) {
  const user = await getUser(phone);
  const club = CLUBS[choice];
  user.club = club.name;
  user.clubData = club;
  user.state = 'AWAITING_NAME';
  await saveUser(phone, user);
  await sendMessage(phone, `${club.colors} Correct choice! ${club.name} fan forever! 🔥\n\nWhat's your full name?`);
}

async function showBalance(phone) {
  const user = await getUser(phone);
  const colors = user.clubData?.colors || '🏦';
  const club = user.club ? `${user.club} fan` : 'FanBank member';
  await sendMessage(
    phone,
    `${colors} *FanBank Wallet — ${club}*\n\n` +
    `💰 Wallet Balance: ₦${user.balance.toLocaleString()}\n` +
    `🐷 FanSave Pot: ₦${user.fansave.toLocaleString()}\n` +
    `⚡ XP: ${user.xp}\n` +
    `🔥 Streak: ${user.streak} days\n` +
    `🏅 Rank: ${user.rank}` +
    (user.anchorAccountNumber ? `\n\n🏦 Account: ${user.anchorAccountNumber} (${user.anchorBankName})` : '')
  );
}

async function executeTransfer(phone, raw) {
  const user = await getUser(phone);
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 3) {
    await sendMessage(phone, 'Format no correct o! Send like this:\n\nAMOUNT | ACCOUNT_NUMBER | BANK_NAME\n\nExample: 5000 | 0123456789 | GTBank');
    return;
  }
  const [amountStr, accountNumber, bankName] = parts;
  const amount = parseAmount(amountStr);

  if (isNaN(amount) || amount <= 0) {
    await sendMessage(phone, 'Amount no valid o! Enter correct number abeg. (e.g. 5000 or 5k)');
    return;
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    await sendMessage(phone, 'Account number must be exactly 10 digits! Check and try again.');
    return;
  }

  user.pendingTransfer = { amount, accountNumber, bankName };
  user.state = 'AWAITING_VOICE';
  await saveUser(phone, user);
  await sendMessage(phone, '🎙️ Before I send, record a short BANTER voice note for the receiver!\n\nSend it now — or type *SKIP* to send without voice banter.');
}

async function completePendingTransfer(phone, audioId) {
  const user = await getUser(phone);
  const { amount, accountNumber, bankName } = user.pendingTransfer;

  user.state = null;
  user.pendingTransfer = null;
  await saveUser(phone, user);

  const result = await anchorTransfer(amount, accountNumber, bankName);

  if (result.success) {
    user.balance = Math.max(0, user.balance - amount);
    user.xp += 50;
    await saveUser(phone, user);

    const colors = user.clubData?.colors || '🏦';
    const banter = await claudeGenerateBanterReceipt(user.club, user.clubData, amount, accountNumber, bankName);

    if (audioId) {
      const receiver = process.env.RECEIVER_PHONE;
      if (receiver) {
        console.log(`[AUDIO] Forwarding voice note audioId=${audioId} to ${receiver}`);
        await sendAudio(receiver, audioId);
      }
    }

    await sendMessage(
      phone,
      `${colors} *Transfer Successful!*\n\n` +
      `Amount: ₦${amount.toLocaleString()}\n` +
      `Account: ${accountNumber}\n` +
      `Bank: ${bankName}\n\n` +
      `🎭 *Banter Receipt:*\n${banter}\n\n` +
      `+50 XP earned!${audioId ? '\n\n🎙️ Your banter voice note don land for the receiver!' : ''}`
    );
  } else {
    await sendMessage(phone, 'Transfer failed! Something went wrong. Please try again.');
  }
}

async function executeAirtime(phone, raw) {
  const user = await getUser(phone);
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 2) {
    await sendMessage(phone, 'Format no correct! Send like this:\n\nPHONE_NUMBER | AMOUNT\n\nExample: 08012345678 | 500');
    return;
  }
  const [airtimePhone, amountStr] = parts;
  const amount = parseAmount(amountStr);

  if (!/^\d{11}$/.test(airtimePhone)) {
    await sendMessage(phone, 'Phone number must be 11 digits! Check and try again.');
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    await sendMessage(phone, 'Amount no valid! Enter correct number abeg.');
    return;
  }

  user.state = null;
  await saveUser(phone, user);

  const result = await vtpassAirtime(airtimePhone, amount);
  if (result.success) {
    user.balance = Math.max(0, user.balance - amount);
    user.xp += 20;
    await saveUser(phone, user);
    const colors = user.clubData?.colors || '🏦';
    await sendMessage(
      phone,
      `${colors} *Airtime Sent!*\n\nPhone: ${airtimePhone}\nAmount: ₦${amount.toLocaleString()}\n\n+20 XP earned! Na you baddest!`
    );
  } else {
    await sendMessage(phone, 'Airtime purchase failed! Try again or contact support.');
  }
}

// ─── Main message handler ────────────────────────────────────────────────────

async function handleMessage(phone, messageType, text, audioId, messageId) {
  const user = await getUser(phone);

  await sendTyping(phone, messageId);

  // ── AWAITING_VOICE: user should send voice note or SKIP ──
  if (user.state === 'AWAITING_VOICE') {
    if (messageType === 'audio' && audioId) return completePendingTransfer(phone, audioId);
    if (messageType === 'text' && text?.toLowerCase().trim() === 'skip') return completePendingTransfer(phone, null);
    return sendMessage(phone, '🎙️ Send a voice note for the receiver or type *SKIP* to send without banter.');
  }

  // ── AWAITING_NAME: collect full name after club selection ──
  if (user.state === 'AWAITING_NAME') {
    if (messageType !== 'text' || !text) return sendMessage(phone, 'Please type your full name.');
    user.name = text.trim();
    user.state = 'AWAITING_BVN';
    await saveUser(phone, user);
    await sendMessage(phone, `Nice one, ${user.name}! 🎉\n\nNow enter your *BVN* to set up your FanBank virtual account:`);
    return;
  }

  // ── AWAITING_BVN: validate BVN, create Anchor account, send welcome image ──
  if (user.state === 'AWAITING_BVN') {
    if (messageType !== 'text' || !text) return sendMessage(phone, 'Please enter your 11-digit BVN.');
    const bvn = text.trim();
    if (!/^\d{11}$/.test(bvn)) {
      await sendMessage(phone, 'BVN must be exactly 11 digits! Check and try again.');
      return;
    }

    await sendMessage(phone, '⏳ Setting up your FanBank account, hold on...');

    try {
      const { customerId, accountNumber, bankName } = await createAnchorAccount(phone, user.name, bvn);

      user.anchorCustomerId = customerId;
      user.anchorAccountNumber = accountNumber;
      user.anchorBankName = bankName;
      user.state = null;
      await saveUser(phone, user);

      await sendMessage(
        phone,
        `🎉 *Your FanBank Account is Ready!*\n\n` +
        `🏦 Bank: ${bankName}\n` +
        `💳 Account Number: ${accountNumber}\n` +
        `👤 Name: ${user.name}\n\n` +
        `You are now a certified ${user.club} legend on FanBank!\n\n` +
        `Type BAL to see your wallet, SEND to transfer, BUY AIRTIME for airtime.`
      );

      try {
        const imageBuffer = await generateWelcomeImage(user.name, accountNumber, user.club);
        await sendImageBuffer(phone, imageBuffer, `Welcome to FanBank, ${user.name}! 🎉`);
      } catch (imgErr) {
        console.error('Welcome image error:', imgErr.message);
      }

    } catch (err) {
      console.error('Anchor account creation error:', err?.response?.data || err.message);
      user.state = null;
      await saveUser(phone, user);
      await sendMessage(phone, 'Account setup failed! Please try again later or contact support.');
    }
    return;
  }

  if (messageType !== 'text' || !text) return;

  const lower = text.toLowerCase().trim();

  if (lower === 'hi' || lower === 'hello' || lower === 'start' || lower === 'howfar') return showWelcome(phone);
  if (/^[1-6]$/.test(lower) && CLUBS[lower]) return selectClub(phone, lower);
  if (lower === 'bal' || lower === 'balance') return showBalance(phone);

  if (lower.includes('send') || lower.includes('transfer')) {
    user.state = 'TRANSFER';
    await saveUser(phone, user);
    return sendMessage(phone, 'Okay! Who you wan send money to?\n\nReply with:\nAMOUNT | ACCOUNT_NUMBER | BANK_NAME\n\nExample:\n5000 | 0123456789 | GTBank\nor\n5k | 0123456789 | GTBank');
  }

  if (lower.includes('buy airtime')) {
    user.state = 'AIRTIME';
    await saveUser(phone, user);
    return sendMessage(phone, 'No wahala! Which number and how much?\n\nReply with:\nPHONE_NUMBER | AMOUNT\n\nExample:\n08012345678 | 500');
  }

  if (user.state === 'TRANSFER' && /\|/.test(text)) return executeTransfer(phone, text);
  if (user.state === 'AIRTIME' && /\|/.test(text)) return executeAirtime(phone, text);

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
  console.log('[WEBHOOK POST] Full body:', JSON.stringify(req.body, null, 2));

  res.sendStatus(200);

  try {
    if (req.body?.object !== 'whatsapp_business_account') return;

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const messageId = message.id;
    const messageType = message.type;
    let text = message?.text?.body || null;
    if (message.type === 'interactive') {
      text = message?.interactive?.button_reply?.title ||
             message?.interactive?.list_reply?.title || null;
    }
    const audioId = message?.audio?.id || null;

    if (!from) return;

    console.log(`[MSG] from=${from} type=${messageType} text="${text}" audioId=${audioId}`);
    await handleMessage(from, messageType, text, audioId, messageId);
  } catch (err) {
    console.error('POST /webhook error:', err.message);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`FanBank webhook server running on port ${PORT}`);
});
