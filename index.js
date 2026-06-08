const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
let sharp; try { sharp = require('sharp'); } catch (e) { sharp = null; }

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ─── PostgreSQL ────────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fanbank_users (
      phone              TEXT PRIMARY KEY,
      name               TEXT,
      club               TEXT,
      club_data          JSONB,
      balance            NUMERIC DEFAULT 5000,
      fansave            NUMERIC DEFAULT 1200,
      xp                 INTEGER DEFAULT 0,
      streak             INTEGER DEFAULT 0,
      rank               TEXT DEFAULT 'Bronze Banter',
      pin                TEXT,
      state              TEXT,
      pending_transfer   JSONB,
      account_number     TEXT,
      bank_name          TEXT,
      bvn                TEXT
    )
  `);
  console.log('DB ready');
}
initDB().catch(err => console.error('DB init error:', err.message));

// ─── Club config ───────────────────────────────────────────────────────────────

const CLUBS = {
  '1': { name: 'Arsenal',    emoji: '🔴', colors: '🔴⚪', rival: 'Tottenham'  },
  '2': { name: 'Chelsea',    emoji: '🔵', colors: '🔵⚪', rival: 'Arsenal'    },
  '3': { name: 'Man United', emoji: '🔴', colors: '🔴⚫', rival: 'Man City'   },
  '4': { name: 'Liverpool',  emoji: '🔴', colors: '🔴⚪', rival: 'Everton'    },
  '5': { name: 'Barcelona',  emoji: '🔵', colors: '🔵🔴', rival: 'Real Madrid'},
  '6': { name: 'Real Madrid',emoji: '⚪', colors: '⚪🟡', rival: 'Barcelona'  },
};

const CLUB_HEX = {
  'Arsenal':    '#DB0007',
  'Chelsea':    '#034694',
  'Man United': '#DA291C',
  'Liverpool':  '#C8102E',
  'Barcelona':  '#A50044',
  'Real Madrid':'#FEBE10',
};

// ─── DB helpers ────────────────────────────────────────────────────────────────

async function getUser(phone) {
  try {
    const { rows } = await pool.query('SELECT * FROM fanbank_users WHERE phone = $1', [phone]);
    return rows[0] || null;
  } catch (err) {
    console.error('getUser error:', err.message);
    return null;
  }
}

async function upsertUser(phone, fields) {
  try {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const values = [phone, ...Object.values(fields).map(v =>
      (v !== null && v !== undefined && typeof v === 'object') ? JSON.stringify(v) : v
    )];
    const cols = keys.join(', ');
    const insertPH = keys.map((_, i) => `$${i + 2}`).join(', ');
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(
      `INSERT INTO fanbank_users (phone, ${cols})
       VALUES ($1, ${insertPH})
       ON CONFLICT (phone) DO UPDATE SET ${setClauses}`,
      values
    );
  } catch (err) {
    console.error('upsertUser error:', err.message);
  }
}

async function ensureUser(phone) {
  let user = await getUser(phone);
  if (!user) {
    await upsertUser(phone, {
      balance: 5000,
      fansave: 1200,
      xp: 0,
      streak: 0,
      rank: 'Bronze Banter',
      state: null,
      pending_transfer: null,
      pin: null,
    });
    user = await getUser(phone);
  }
  return user;
}

// ─── Anchor bank codes ─────────────────────────────────────────────────────────

const BANK_CODES = {
  'opay': '100004',
  'gtbank': '000013', 'gtb': '000013',
  'access': '000014',
  'zenith': '000015',
  'uba': '000004',
  'first bank': '000016', 'firstbank': '000016',
  'kuda': '090267',
  'palmpay': '100033',
  'moniepoint': '090405',
  'wema': '000017',
  'stanbic': '000012',
  'union': '000018',
  'sterling': '000001',
  'providus': '000023',
  'fidelity': '000007',
};

// ─── Anchor API helpers ────────────────────────────────────────────────────────

const ANCHOR_BASE = 'https://api.sandbox.getanchor.co/api/v1';
const anchorHeaders = {
  'Content-Type': 'application/json',
  'accept': 'application/json',
  'x-anchor-key': process.env.ANCHOR_API_KEY,
};

async function anchorLookupBVN(bvn) {
  try {
    const res = await axios.get(`${ANCHOR_BASE}/customers?bvn=${bvn}`, { headers: anchorHeaders });
    const customer = res.data?.data?.[0];
    if (customer) {
      const a = customer.attributes;
      return {
        name: `${a.firstName || ''} ${a.lastName || ''}`.trim(),
        customerId: customer.id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function anchorCreateCustomer(fullName, bvn) {
  try {
    const res = await axios.post(
      `${ANCHOR_BASE}/customers`,
      {
        data: {
          type: 'IndividualCustomer',
          attributes: { fullName, bvn: bvn || '00000000000' },
        },
      },
      { headers: anchorHeaders }
    );
    return res.data?.data?.id || null;
  } catch (err) {
    console.error('anchorCreateCustomer error:', err?.response?.data || err.message);
    return null;
  }
}

async function anchorCreateVirtualAccount(customerId) {
  try {
    const res = await axios.post(
      `${ANCHOR_BASE}/deposit-accounts`,
      {
        data: {
          type: 'DepositAccount',
          attributes: { currency: 'NGN', productName: 'SAVINGS' },
          relationships: {
            customer: { data: { type: 'IndividualCustomer', id: customerId } },
          },
        },
      },
      { headers: anchorHeaders }
    );
    const acct = res.data?.data;
    return {
      accountId: acct?.id,
      accountNumber: acct?.attributes?.accountNumber,
      bankName: acct?.attributes?.bankName || acct?.attributes?.bank?.name || 'Anchor MFB',
    };
  } catch (err) {
    console.error('anchorCreateVirtualAccount error:', err?.response?.data || err.message);
    return null;
  }
}

async function anchorTransfer(amount, accountNumber, bankName) {
  try {
    const bankCode = BANK_CODES[bankName.toLowerCase()] || bankName;

    const cpRes = await axios.post(
      `${ANCHOR_BASE}/counterparties`,
      {
        data: {
          type: 'CounterParty',
          attributes: {
            accountName: 'FanBank User',
            accountNumber,
            bankCode,
          },
        },
      },
      { headers: anchorHeaders }
    );
    const counterpartyId = cpRes.data?.data?.id;
    if (!counterpartyId) throw new Error('No counterparty ID returned');

    const transferRes = await axios.post(
      `${ANCHOR_BASE}/transfers`,
      {
        data: {
          type: 'NIPTransfer',
          attributes: {
            amount: amount * 100,
            currency: 'NGN',
            reason: 'FanBank Transfer',
            reference: `fanbank_${Date.now()}`,
          },
          relationships: {
            counterParty: { data: { type: 'CounterParty', id: counterpartyId } },
            account: { data: { type: 'DepositAccount', id: process.env.ANCHOR_FBO_ACCOUNT_ID } },
          },
        },
      },
      { headers: anchorHeaders }
    );
    return { success: true, data: transferRes.data };
  } catch (err) {
    console.error('Anchor transfer error:', err?.response?.data || err.message);
    return { success: false, error: err?.response?.data };
  }
}

// ─── VTPass placeholder ────────────────────────────────────────────────────────

async function vtpassAirtime(phone, amount) {
  console.log(`[VTPass] Airtime ₦${amount} to ${phone}`);
  return { success: true };
}

// ─── Claude helpers ────────────────────────────────────────────────────────────

async function claudeGenerateBanterReceipt(senderClub, clubData, amount, accountNumber, bankName) {
  const rival = clubData?.rival || 'their rival';
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 150,
    system:
      'You are FanBank banter generator. Generate ONE short savage football banter receipt message maximum 3 sentences. Use Nigerian expressions. Be funny and savage about the sender club. Reference their rival. Never make up transaction details. Just write the banter text only.',
    messages: [
      {
        role: 'user',
        content: `Sender supports ${senderClub || 'unknown club'} (rival: ${rival}). They just sent ₦${amount} to account ${accountNumber} at ${bankName}. Write the savage banter receipt.`,
      },
    ],
  });
  return msg.content[0].text;
}

async function claudeRespond(phone, text) {
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 200,
    system:
      "You are FanBank AI assistant for the World's First Banter Neo Gaming Bank. You speak like a witty Nigerian football fan. Use Nigerian expressions naturally. You help users understand FanBank features. You NEVER confirm transactions, NEVER quote balances, NEVER process payments — tell users to type SEND for transfers, BAL for balance, BUY AIRTIME for airtime. You only chat, explain features, and generate banter. Keep responses short for WhatsApp.",
    messages: [{ role: 'user', content: text }],
  });
  await sendMessage(phone, msg.content[0].text);
}

// ─── WhatsApp send helpers ─────────────────────────────────────────────────────

async function sendTyping(to, messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendTyping error:', err?.response?.data || err.message);
  }
}

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

async function sendClubMessage(to, text, user) {
  const colors = user?.club_data?.colors || user?.clubData?.colors || '🏦';
  await sendMessage(to, `${colors} ${text}`);
}

async function sendQuickReplies(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Quick actions:' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'FUND', title: '💰 FUND' } },
              { type: 'reply', reply: { id: 'SEND', title: '💸 SEND' } },
              { type: 'reply', reply: { id: 'BAL',  title: '📊 BAL'  } },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendQuickReplies error:', err?.response?.data || err.message);
  }
}

async function reply(to, text, user) {
  await sendClubMessage(to, text, user);
  await sendQuickReplies(to);
}

async function sendInteractiveList(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'Pick your club and let the banter begin! 🏆' },
          action: {
            button: 'Choose Club',
            sections: [
              {
                title: 'Premier League',
                rows: [
                  { id: 'club_1', title: '🔴⚪ Arsenal',    description: 'The Gunners'    },
                  { id: 'club_2', title: '🔵⚪ Chelsea',    description: 'The Blues'       },
                  { id: 'club_3', title: '🔴⚫ Man United', description: 'The Red Devils'  },
                  { id: 'club_4', title: '🔴⚪ Liverpool',  description: 'The Reds'        },
                ],
              },
              {
                title: 'La Liga',
                rows: [
                  { id: 'club_5', title: '🔵🔴 Barcelona',   description: 'Blaugrana'    },
                  { id: 'club_6', title: '⚪🟡 Real Madrid', description: 'Los Blancos'  },
                ],
              },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendInteractiveList error:', err?.response?.data || err.message);
  }
}

async function forwardAudio(to, audioId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: audioId } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('forwardAudio error:', err?.response?.data || err.message);
  }
}

// ─── Welcome flier (sharp) ─────────────────────────────────────────────────────

async function generateWelcomeFlier(user) {
  try {
    if (!sharp) throw new Error('sharp not available');
    const clubName = user.club || 'FanBank';
    const bgHex = CLUB_HEX[clubName] || '#1a1a2e';
    const name = (user.name || 'Fan').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const acctNum = (user.account_number || 'Pending').replace(/&/g, '&amp;');
    const bankNameVal = (user.bank_name || 'FanBank').replace(/&/g, '&amp;');
    const clubLabel = clubName.replace(/&/g, '&amp;');

    const svg = `<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="450" fill="${bgHex}"/>
      <text x="400" y="90"  font-family="sans-serif" font-size="64" fill="white" text-anchor="middle" font-weight="bold">FanBank</text>
      <text x="400" y="135" font-family="sans-serif" font-size="20" fill="white" text-anchor="middle">World's First Banter Neo Gaming Bank</text>
      <text x="400" y="210" font-family="sans-serif" font-size="38" fill="white" text-anchor="middle">${name}</text>
      <text x="400" y="265" font-family="sans-serif" font-size="22" fill="white" text-anchor="middle">${clubLabel} Fan</text>
      <text x="400" y="330" font-family="sans-serif" font-size="38" fill="white" text-anchor="middle">${acctNum}</text>
      <text x="400" y="380" font-family="sans-serif" font-size="22" fill="white" text-anchor="middle">${bankNameVal}</text>
      <text x="400" y="430" font-family="sans-serif" font-size="18" fill="white" text-anchor="middle">Powered by Anchor • fanbank.ng</text>
    </svg>`;

    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch (err) {
    console.log('Image generation skipped:', err.message);
    return null;
  }
}

async function sendWelcomeFlier(phone, user) {
  try {
    const imgBuf = await generateWelcomeFlier(user);
    if (!imgBuf) return;

    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', imgBuf, { filename: 'welcome.png', contentType: 'image/png' });
    form.append('type', 'image/png');
    form.append('messaging_product', 'whatsapp');

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`,
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mediaId = uploadRes.data?.id;
    if (!mediaId) return;

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'image',
        image: {
          id: mediaId,
          caption: `${user.club_data?.colors || '🏦'} Welcome to FanBank, ${user.name}! Your account is ready. 🎉`,
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendWelcomeFlier error:', err?.response?.data || err.message);
  }
}

// ─── Onboarding flow ───────────────────────────────────────────────────────────

async function showWelcome(phone) {
  await sendMessage(
    phone,
    '🏦 Welcome to *FanBank* — World\'s First Banter Neo Gaming Bank!\n\nBank with your club. Transfer money with savage banter. Earn XP for every flex.\n\nChoose your club to get started 👇'
  );
  await sendInteractiveList(phone);
}

async function handleClubSelection(phone, clubKey) {
  const club = CLUBS[clubKey];
  await upsertUser(phone, {
    club: club.name,
    club_data: club,
    state: 'AWAITING_BVN',
  });
  const user = await getUser(phone);
  await reply(phone, `${club.emoji} *${club.name}* selected! Na true supporter!\n\nNow enter your BVN to verify your identity and open your account:\n\n_(Reply with your 11-digit BVN)_`, user);
}

async function handleBVN(phone, bvnText) {
  const bvn = bvnText.trim().replace(/\s/g, '');
  const user = await getUser(phone);

  if (!/^\d{11}$/.test(bvn)) {
    await reply(phone, '❌ BVN must be exactly 11 digits. Try again:', user);
    return;
  }

  await upsertUser(phone, { bvn });
  await reply(phone, '🔍 Verifying your BVN... one moment...', user);

  const lookup = await anchorLookupBVN(bvn);
  if (lookup) {
    await upsertUser(phone, {
      name: lookup.name,
      state: 'CREATING_ACCOUNT',
    });
    const updated = await getUser(phone);
    await finishOnboarding(phone, bvn, lookup.name, lookup.customerId, updated);
  } else {
    await upsertUser(phone, { state: 'AWAITING_NAME', pending_transfer: { bvn } });
    await reply(phone, '📝 BVN lookup pending. Enter your full name to continue:', user);
  }
}

async function handleManualName(phone, nameText) {
  const name = nameText.trim();
  const user = await getUser(phone);
  if (name.length < 3) {
    await reply(phone, '❌ Name too short. Enter your full name:', user);
    return;
  }
  const bvn = user.pending_transfer?.bvn;
  const customerId = await anchorCreateCustomer(name, bvn);
  await upsertUser(phone, {
    name,
    state: 'CREATING_ACCOUNT',
    pending_transfer: null,
  });
  const updated = await getUser(phone);
  await finishOnboarding(phone, bvn, name, customerId, updated);
}

async function finishOnboarding(phone, bvn, name, customerId, user) {
  await reply(phone, `✅ Identity confirmed! Welcome, *${name}*!\n\n🏗️ Creating your FanBank virtual account...`, user);

  let accountNumber = null;
  let bankName = 'Anchor MFB';

  if (customerId) {
    const acct = await anchorCreateVirtualAccount(customerId);
    if (acct) {
      accountNumber = acct.accountNumber;
      bankName = acct.bankName || 'Anchor MFB';
    }
  }

  await upsertUser(phone, {
    name,
    account_number: accountNumber,
    bank_name: bankName,
    state: 'SETTING_PIN',
  });

  const updated = await getUser(phone);
  await reply(
    phone,
    `🎉 Account ready!\n\n💳 Account Number: *${accountNumber || 'Pending'}*\n🏦 Bank: ${bankName}\n\nNow choose your *4-digit banter code* 🔐\n_(This PIN protects every transfer)_`,
    updated
  );
}

// ─── Balance ───────────────────────────────────────────────────────────────────

async function showBalance(phone) {
  const user = await ensureUser(phone);
  const colors = user.club_data?.colors || '🏦';
  const club = user.club ? `${user.club} fan` : 'FanBank member';
  await reply(
    phone,
    `*FanBank Wallet — ${club}*\n\n💰 Wallet Balance: ₦${Number(user.balance).toLocaleString()}\n🐷 FanSave Pot: ₦${Number(user.fansave).toLocaleString()}\n⚡ XP: ${user.xp}\n🔥 Streak: ${user.streak} days\n🏅 Rank: ${user.rank}${user.account_number ? `\n\n💳 Account: ${user.account_number}\n🏦 Bank: ${user.bank_name || 'FanBank'}` : ''}`,
    user
  );
}

// ─── Transfer flow ─────────────────────────────────────────────────────────────

async function executeTransfer(phone, raw) {
  const user = await getUser(phone);
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 3) {
    await reply(phone, 'Format no correct o! Send like this:\n\nAMOUNT | ACCOUNT_NUMBER | BANK_NAME\n\nExample: 5000 | 0123456789 | GTBank', user);
    return;
  }
  const [amountStr, accountNumber, bankName] = parts;

  const cleanAmount = amountStr.toLowerCase().replace(/,/g, '');
  const amount = cleanAmount.endsWith('k') ? parseFloat(cleanAmount) * 1000 : parseFloat(cleanAmount);

  if (isNaN(amount) || amount <= 0) {
    await reply(phone, 'Amount no valid o! Enter correct number abeg.', user);
    return;
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    await reply(phone, 'Account number must be exactly 10 digits!', user);
    return;
  }
  await upsertUser(phone, {
    pending_transfer: { amount, accountNumber, bankName },
    state: 'AWAITING_PIN',
  });
  const updated = await getUser(phone);
  await reply(phone, `💸 Sending ₦${amount.toLocaleString()} to ${accountNumber} (${bankName})\n\n🔐 Drop your banter code to confirm:`, updated);
}

async function completePendingTransfer(phone, audioId) {
  const user = await getUser(phone);
  const { amount, accountNumber, bankName } = user.pending_transfer;
  await upsertUser(phone, { state: null, pending_transfer: null });
  const result = await anchorTransfer(amount, accountNumber, bankName);
  const updated = await getUser(phone);
  if (result.success) {
    const newBal = Math.max(0, Number(updated.balance) - amount);
    await upsertUser(phone, { balance: newBal, xp: updated.xp + 50 });
    const finalUser = await getUser(phone);
    const banter = await claudeGenerateBanterReceipt(updated.club, updated.club_data, amount, accountNumber, bankName);
    await reply(
      phone,
      `*Transfer Successful!*\n\nAmount: ₦${amount.toLocaleString()}\nAccount: ${accountNumber}\nBank: ${bankName}\n\n🎭 *Banter Receipt:*\n${banter}\n\n+50 XP earned! Na you baddest! 🔥`,
      finalUser
    );
    if (audioId) {
      await forwardAudio(accountNumber, audioId);
      await sendMessage(phone, '✅ Savage voice note forwarded! They go hear am! 😂');
    }
  } else {
    await reply(phone, 'Transfer failed! Try again.', updated);
  }
}

// ─── Airtime flow ──────────────────────────────────────────────────────────────

async function executeAirtime(phone, raw) {
  const user = await getUser(phone);
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 2) {
    await reply(phone, 'Format no correct! Send like this:\n\nPHONE_NUMBER | AMOUNT\n\nExample: 08012345678 | 500', user);
    return;
  }
  const [airtimePhone, amountStr] = parts;
  const cleanAmount = amountStr.toLowerCase().replace(/,/g, '');
  const amount = cleanAmount.endsWith('k') ? parseFloat(cleanAmount) * 1000 : parseFloat(cleanAmount);

  if (!/^\d{11}$/.test(airtimePhone)) {
    await reply(phone, 'Phone number must be 11 digits! Check and try again.', user);
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    await reply(phone, 'Amount no valid! Enter correct number abeg.', user);
    return;
  }

  await upsertUser(phone, { state: null });
  const result = await vtpassAirtime(airtimePhone, amount);
  if (result.success) {
    const newBal = Math.max(0, Number(user.balance) - amount);
    await upsertUser(phone, { balance: newBal, xp: user.xp + 20 });
    const updated = await getUser(phone);
    await reply(phone, `*Airtime Sent!*\n\nPhone: ${airtimePhone}\nAmount: ₦${amount.toLocaleString()}\n\n+20 XP earned! Na you baddest!`, updated);
  } else {
    await reply(phone, 'Airtime purchase failed! Try again or contact support.', user);
  }
}

// ─── Main message handler ──────────────────────────────────────────────────────

async function handleMessage(phone, text, messageId, messageType, audioId, interactiveReply) {
  await sendTyping(phone, messageId);

  const lower = (text || '').toLowerCase().trim();

  if (lower === 'hi' || lower === 'hello' || lower === 'start' || lower === 'howfar') {
    return showWelcome(phone);
  }

  if (interactiveReply?.type === 'list_reply') {
    const rowId = interactiveReply.list_reply?.id || '';
    const match = rowId.match(/^club_([1-6])$/);
    if (match) return handleClubSelection(phone, match[1]);
  }

  if (interactiveReply?.type === 'button_reply') {
    const btnId = interactiveReply.button_reply?.id || '';
    if (btnId === 'BAL' || lower === 'bal' || lower === 'balance') return showBalance(phone);
    if (btnId === 'SEND') {
      const user = await ensureUser(phone);
      await upsertUser(phone, { state: 'TRANSFER' });
      return reply(phone, 'Who you wan send money to?\n\nReply with:\nAMOUNT | ACCOUNT_NUMBER | BANK_NAME\n\nExample:\n5000 | 0123456789 | GTBank', user);
    }
    if (btnId === 'FUND') {
      const user = await ensureUser(phone);
      return reply(phone, `💳 Fund your FanBank wallet:\n\nAccount Number: *${user.account_number || 'Pending setup'}*\nBank: ${user.bank_name || 'FanBank (Anchor)'}\n\nSend any amount to this account to top up!`, user);
    }
  }

  if (/^[1-6]$/.test(lower) && CLUBS[lower]) {
    const user = await getUser(phone);
    if (!user?.club) return handleClubSelection(phone, lower);
  }

  const user = await ensureUser(phone);

  if (user.state === 'AWAITING_BVN')  return handleBVN(phone, text || '');
  if (user.state === 'AWAITING_NAME') return handleManualName(phone, text || '');

  if (user.state === 'SETTING_PIN') {
    if (!/^\d{4}$/.test((text || '').trim())) {
      await reply(phone, '❌ Must be exactly 4 digits! Try again:', user);
      return;
    }
    await upsertUser(phone, { pin: text.trim(), state: 'DONE' });
    const updated = await getUser(phone);
    await sendWelcomeFlier(phone, updated);
    await reply(
      phone,
      `✅ Banter code set! You are ready to flex! 🔥\n\nType *BAL* for balance\nType *SEND* to transfer\nType *BUY AIRTIME* for airtime`,
      updated
    );
    return;
  }

  if (user.state === 'AWAITING_PIN') {
    if (!/^\d{4}$/.test((text || '').trim())) {
      await reply(phone, '❌ Invalid code! Enter your 4-digit banter code:', user);
      return;
    }
    if (!user.pin) {
      await upsertUser(phone, { state: null, pending_transfer: null });
      await reply(phone, '❌ You have no PIN set. Type SETPIN to create one.', user);
      return;
    }
    if (text.trim() !== user.pin) {
      await reply(phone, '❌ Wrong banter code! Try again:', user);
      return;
    }
    await upsertUser(phone, { state: 'AWAITING_VOICE' });
    const updated = await getUser(phone);
    await reply(phone, '🎙️ PIN confirmed! Now record a savage voice note for the receiver — or type SKIP to send without banter.', updated);
    return;
  }

  if (user.state === 'AWAITING_VOICE') {
    if (messageType === 'audio' && audioId) return completePendingTransfer(phone, audioId);
    if (lower === 'skip') return completePendingTransfer(phone, null);
    await reply(phone, '🎙️ Send a voice note or type SKIP.', user);
    return;
  }

  if (lower === 'setpin') {
    await upsertUser(phone, { state: 'SETTING_PIN' });
    await reply(phone, '🔐 Choose your 4-digit banter code:', user);
    return;
  }

  if (user.state === 'TRANSFER' && text && /\|/.test(text)) return executeTransfer(phone, text);
  if (user.state === 'AIRTIME'  && text && /\|/.test(text)) return executeAirtime(phone, text);

  if (lower === 'bal' || lower === 'balance') return showBalance(phone);

  if (lower.includes('send') || lower.includes('transfer')) {
    await upsertUser(phone, { state: 'TRANSFER' });
    return reply(phone, 'Okay! Who you wan send money to?\n\nReply with:\nAMOUNT | ACCOUNT_NUMBER | BANK_NAME\n\nExample:\n5000 | 0123456789 | GTBank', user);
  }

  if (lower.includes('buy airtime') || lower.includes('airtime')) {
    await upsertUser(phone, { state: 'AIRTIME' });
    return reply(phone, 'No wahala! Which number and how much?\n\nReply with:\nPHONE_NUMBER | AMOUNT\n\nExample:\n08012345678 | 500', user);
  }

  if (lower === 'fund' || lower.includes('fund wallet') || lower.includes('top up')) {
    return reply(phone, `💳 Fund your FanBank wallet:\n\nAccount Number: *${user.account_number || 'Pending setup'}*\nBank: ${user.bank_name || 'FanBank (Anchor)'}\n\nSend any amount to this account to top up!`, user);
  }

  return claudeRespond(phone, text);
}

// ─── Routes ────────────────────────────────────────────────────────────────────

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

    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from        = message.from;
    const messageType = message.type;
    let text = message?.text?.body || null;
    if (message.type === 'interactive') {
      text = message?.interactive?.button_reply?.title ||
             message?.interactive?.list_reply?.title || null;
      if (text) text = text.replace(/[^\w\s]/gi, '').trim();
    }
    const audioId   = message?.audio?.id || null;
    const messageId = message.id;

    const interactiveReply = message?.interactive
      ? { type: message.interactive.type, list_reply: message.interactive.list_reply, button_reply: message.interactive.button_reply }
      : null;

    if (!from) return;
    if (!text && messageType !== 'audio' && !interactiveReply) return;

    console.log(`[MSG] from=${from} type=${messageType} text="${text}"`);
    await handleMessage(from, text, messageId, messageType, audioId, interactiveReply);
  } catch (err) {
    console.error('POST /webhook error:', err.message);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`FanBank webhook server running on port ${PORT}`);
});
