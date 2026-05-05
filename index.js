'use strict';

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = Number(process.env.PORT || 3000);

// Owner IDs String হিসেবে রাখা হলো যাতে বড় ID-তে সমস্যা না হয়
const OWNER_IDS = (process.env.OWNER_IDS || process.env.OWNER_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN || !CHANNEL_ID || OWNER_IDS.length === 0) {
  console.error('Missing Environment Variables! Required: BOT_TOKEN, CHANNEL_ID, OWNER_IDS');
  process.exit(1);
}

function isOwner(uid) {
  return OWNER_IDS.includes(String(uid));
}

// ---------------- EXPRESS (Health Server) ----------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Channel Manager Pro Bot is Online & Running perfectly.');
});

const server = app.listen(PORT, () => {
  console.log(`Health server running on :${PORT}`);
});

// ---------------- BOT ----------------
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    interval: 300,
  },
});

process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));

// ---------------- SESSION ----------------
const STATES = Object.freeze({
  IDLE: 'IDLE',
  WAIT_MEDIA: 'WAIT_MEDIA',
  WAIT_STYLE: 'WAIT_STYLE',
  WAIT_STYLE_PREVIEW: 'WAIT_STYLE_PREVIEW',
  WAIT_TEXT: 'WAIT_TEXT',
  WAIT_RAW: 'WAIT_RAW',
  WAIT_SPOILER: 'WAIT_SPOILER',
  WAIT_REPOST: 'WAIT_REPOST',
  WAIT_CONFIRM: 'WAIT_CONFIRM',
});

const sessions = Object.create(null);

function defaultSession() {
  return {
    chatId: null,
    state: STATES.IDLE,
    mode: null,
    selectedStyle: 'normal',
    previewStyle: null,
    postType: 'text',
    mediaId: null,
    album: { id: null, items: [], timer: null },
    mediaAlbumItems: null,
    draftBlocks: [],
    draftButtons: [],
    pending: null,
    lastMenuMsgId: null,
  };
}

function getSession(uid) {
  if (!sessions[uid]) sessions[uid] = defaultSession();
  return sessions[uid];
}

function clearAlbumTimer(session) {
  if (session?.album?.timer) {
    clearTimeout(session.album.timer);
    session.album.timer = null;
  }
}

function resetSession(uid, keepMenuId = true) {
  const last = sessions[uid]?.lastMenuMsgId ?? null;
  const chatId = sessions[uid]?.chatId ?? null;
  clearAlbumTimer(sessions[uid]);

  sessions[uid] = defaultSession();
  if (keepMenuId) sessions[uid].lastMenuMsgId = last;
  sessions[uid].chatId = chatId;
}

// ---------------- UTILITIES ----------------
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ইউজারের মেসেজ ডিলিট করার চেষ্টা করবে, না পারলে বটের আগের মেসেজ ডিলিট করে UI ফ্রেশ রাখবে
async function cleanUI(chatId, msgIdToDelete, uid) {
  try {
    if (msgIdToDelete) await bot.deleteMessage(chatId, msgIdToDelete).catch(() => {});
  } catch (error) {}
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function parseButtonsBlock(inputText) {
  const raw = String(inputText || '');
  const lines = raw.split('\n');
  const markerIndex = lines.findIndex(l => l.trim().toUpperCase() === 'BUTTONS:');
  
  if (markerIndex === -1) return { textOnly: raw.trim(), buttons: [] };

  const textOnly = lines.slice(0, markerIndex).join('\n').trim();
  const btnLines = lines.slice(markerIndex + 1).map(l => l.trim()).filter(Boolean);
  const buttons = [];

  for (const line of btnLines) {
    const rowButtons = line.split('||').map(b => b.trim()).filter(Boolean);
    const row = [];
    for (const btn of rowButtons) {
      const parts = btn.split('|').map(p => p.trim());
      if (parts.length >= 2 && normalizeUrl(parts[1])) {
        row.push({ text: parts[0].slice(0, 64), url: normalizeUrl(parts[1]) });
      }
    }
    if (row.length) buttons.push(row);
  }
  return { textOnly, buttons };
}

// ---------------- HTML BUILDER ----------------
function buildStyledHtml(style, plainText) {
  const text = String(plainText || '');
  const safe = escapeHtml(text);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  switch (style) {
    case 'title': return `🏆 <b>${escapeHtml(text.toUpperCase())}</b>\n━━━━━━━━━━━━━━━━━`;
    case 'bold': return `<b>${safe}</b>`;
    case 'italic': return `<i>${safe}</i>`;
    case 'underline': return `<u>${safe}</u>`;
    case 'strike': return `<s>${safe}</s>`;
    case 'spoiler': return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code': return `<code>${safe}</code>`;
    case 'pre': return `<pre>${safe}</pre>`;
    case 'quote': return `<blockquote>${safe}</blockquote>`;
    case 'expand_quote': return `<blockquote expandable>${safe}</blockquote>`;
    case 'heading': return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets': return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'numbered': return lines.map((l, i) => `<b>${i + 1}.</b> ${escapeHtml(l)}`).join('\n');
    case 'pros': return lines.map(l => `✅ ${escapeHtml(l)}`).join('\n');
    case 'cons': return lines.map(l => `❌ ${escapeHtml(l)}`).join('\n');
    case 'note': return `📌 <b>Note:</b> ${safe}`;
    case 'warning': return `⚠️ <b>Warning:</b> ${safe}`;
    case 'center': return `──────────────\n<b>${safe}</b>\n──────────────`;
    case 'divider': return `━━━━━━━━━━━━━━━━━━`;
    default: return safe;
  }
}

// ---------------- MENUS ----------------
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: '⚡ Quick Text', callback_data: 'mode_quick' }, { text: '🧱 Multi Block', callback_data: 'mode_multi' }],
    [{ text: '📎 Media / Album', callback_data: 'mode_media' }, { text: '📝 Raw HTML', callback_data: 'mode_raw' }],
    [{ text: '😶‍🌫️ Spoiler', callback_data: 'mode_spoiler' }, { text: '🔄 Repost', callback_data: 'mode_repost' }],
    [{ text: '❌ Reset Bot', callback_data: 'reset' }],
  ],
};

const CANCEL_MENU = { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'cancel' }]] };

const CONFIRM_MENU = {
  inline_keyboard: [
    [{ text: '✅ Publish', callback_data: 'pub_normal' }, { text: '🔕 Silent Publish', callback_data: 'pub_silent' }],
    [{ text: '📌 Publish & Pin', callback_data: 'pub_pin' }],
    [{ text: '✏️ Edit Again', callback_data: 'confirm_edit' }, { text: '❌ Cancel', callback_data: 'cancel' }],
  ],
};

const STYLES = [
  { id: 'normal', text: 'Normal 🔤' }, { id: 'title', text: '🏆 Title' },
  { id: 'bold', text: 'Bold' }, { id: 'italic', text: 'Italic' },
  { id: 'code', text: 'Code' }, { id: 'quote', text: '❝ Quote' },
  { id: 'bullets', text: '• Bullets' }, { id: 'numbered', text: '1️⃣ Numbered' },
  { id: 'pros', text: '✅ Pros' }, { id: 'cons', text: '❌ Cons' },
  { id: 'note', text: '📌 Note' }, { id: 'divider', text: '➖ Divider' }
];

function getStyleMenu(session) {
  const keyboard = [];
  if (session.mode === 'media' && (session.mediaId || session.mediaAlbumItems)) {
    keyboard.push([{ text: '🚀 Skip Caption (Send Directly)', callback_data: 'action_skip_caption' }]);
  }
  for (let i = 0; i < STYLES.length; i += 2) {
    keyboard.push([
      { text: STYLES[i].text, callback_data: `style_${STYLES[i].id}` },
      ...(STYLES[i + 1] ? [{ text: STYLES[i + 1].text, callback_data: `style_${STYLES[i + 1].id}` }] : []),
    ]);
  }
  if (session.mode === 'multi' && session.draftBlocks.length > 0) {
    keyboard.push([{ text: `🚀 Publish (${session.draftBlocks.length} blocks)`, callback_data: 'action_publish' }]);
  }
  keyboard.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: keyboard };
}

// ---------------- UI UPDATER (SCREEN FRESH) ----------------
async function updateUI(chatId, uid, text, markup) {
  const session = getSession(uid);
  const payload = { parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) };

  // স্ক্রিন ফ্রেশ করার জন্য আগের মেসেজ ডিলিট করে নতুন করে পাঠানো (যাতে মেনু সবসময় নিচে থাকে)
  if (session.lastMenuMsgId) {
    await bot.deleteMessage(chatId, session.lastMenuMsgId).catch(() => {});
  }
  const sent = await bot.sendMessage(chatId, text, payload);
  session.lastMenuMsgId = sent.message_id;
}

// ---------------- PUBLISH HELPERS ----------------
async function executePublish(session, options) {
  const p = session.pending;
  const sendOpts = { 
    parse_mode: 'HTML', 
    disable_web_page_preview: true,
    disable_notification: options.silent || false,
    ...(p.buttons ? { reply_markup: { inline_keyboard: p.buttons } } : {})
  };

  let sentMsg;

  if (p.kind === 'text') {
    sentMsg = await bot.sendMessage(CHANNEL_ID, p.html, sendOpts);
  } else if (p.kind === 'media') {
    sendOpts.caption = p.html || '';
    if (p.postType === 'photo') sentMsg = await bot.sendPhoto(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'video') sentMsg = await bot.sendVideo(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'document') sentMsg = await bot.sendDocument(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'audio') sentMsg = await bot.sendAudio(CHANNEL_ID, p.mediaId, sendOpts);
  } else if (p.kind === 'album') {
    const mediaGroup = p.items.map((it, idx) => ({
      type: it.type, media: it.media,
      ...(idx === 0 && p.html ? { caption: p.html, parse_mode: 'HTML' } : {})
    }));
    const msgs = await bot.sendMediaGroup(CHANNEL_ID, mediaGroup, { disable_notification: options.silent });
    sentMsg = msgs[0]; 
    if (p.buttons) await bot.sendMessage(CHANNEL_ID, '🔗 Links:', sendOpts);
  }

  if (options.pin && sentMsg) {
    await bot.pinChatMessage(CHANNEL_ID, sentMsg.message_id, { disable_notification: options.silent });
  }
}

// ---------------- COMMANDS & HANDLERS ----------------
bot.onText(/^\/(start|menu)$/i, async (msg) => {
  const uid = String(msg.from?.id);
  const chatId = msg.chat.id;

  if (!isOwner(uid)) {
    return bot.sendMessage(chatId, '🚫 <b>Access Denied!</b> You are not authorized.', { parse_mode: 'HTML' });
  }
  
  await cleanUI(chatId, msg.message_id, uid);
  resetSession(uid, false);
  await updateUI(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\nএকটি মোড নির্বাচন করুন:`, MAIN_MENU);
});

bot.on('callback_query', async (query) => {
  const uid = String(query.from?.id);
  const chatId = query.message.chat.id;
  const data = query.data;
  
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
  bot.answerCallbackQuery(query.id).catch(() => {});

  const session = getSession(uid);
  session.chatId = chatId;

  if (data === 'cancel' || data === 'reset') {
    resetSession(uid, false);
    return updateUI(chatId, uid, `🏠 <b>Main Menu</b>\n\nঅপারেশন বাতিল করা হয়েছে।`, MAIN_MENU);
  }

  if (data.startsWith('pub_')) {
    try {
      const isSilent = data === 'pub_silent';
      const isPin = data === 'pub_pin';
      
      await executePublish(session, { silent: isSilent, pin: isPin });
      resetSession(uid, false);
      return updateUI(chatId, uid, `✅ <b>Successfully Published to Channel!</b> 🎉`, MAIN_MENU);
    } catch (err) {
      return updateUI(chatId, uid, `❌ <b>Publish Failed:</b> ${err.message}\n\nচেক করুন বট চ্যানেলের এডমিন কিনা।`, CANCEL_MENU);
    }
  }

  if (data.startsWith('mode_')) {
    session.mode = data.replace('mode_', '');
    if (session.mode === 'media') {
      session.state = STATES.WAIT_MEDIA;
      return updateUI(chatId, uid, `📎 <b>Media Mode</b>\n\nযেকোনো ছবি, ভিডিও বা ডকুমেন্ট পাঠান:`, CANCEL_MENU);
    } else {
      session.state = STATES.WAIT_STYLE;
      session.postType = 'text';
      return updateUI(chatId, uid, `🎨 <b>Text Mode</b>\n\nপোস্টের Style নির্বাচন করুন:`, getStyleMenu(session));
    }
  }

  if (data.startsWith('style_')) {
    session.selectedStyle = data.replace('style_', '');
    session.state = STATES.WAIT_TEXT;
    return updateUI(chatId, uid, `✏️ <b>Send your text now:</b>\n\n(Note: Text এর নিচে বাটন দিতে চাইলে সবার শেষে <code>BUTTONS:\nName | Link</code> লিখুন)`, CANCEL_MENU);
  }

  if (data === 'action_skip_caption') {
    session.pending = { kind: session.postType === 'album' ? 'album' : 'media', postType: session.postType, mediaId: session.mediaId, items: session.mediaAlbumItems, html: '', buttons: null };
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, `🧾 <b>Ready to Publish!</b> (Without Caption)`, CONFIRM_MENU);
  }
});

bot.on('message', async (msg) => {
  const uid = String(msg.from?.id);
  const chatId = msg.chat.id;

  if (!isOwner(uid) || msg.chat.type !== 'private' || msg.text?.startsWith('/')) return;
  
  const session = getSession(uid);
  await cleanUI(chatId, msg.message_id, uid); // ইউজারের পাঠানো মেসেজ ডিলিট করার ট্রাই করবে (UI Clean)

  if (session.state === STATES.WAIT_MEDIA) {
    if (msg.photo) { session.mediaId = msg.photo.pop().file_id; session.postType = 'photo'; }
    else if (msg.video) { session.mediaId = msg.video.file_id; session.postType = 'video'; }
    else if (msg.document) { session.mediaId = msg.document.file_id; session.postType = 'document'; }
    else return updateUI(chatId, uid, `⚠️ Please send a valid Media file.`, CANCEL_MENU);
    
    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `✅ <b>Media Received!</b>\n\nএখন Caption Style নির্বাচন করুন:`, getStyleMenu(session));
  }

  if (session.state === STATES.WAIT_TEXT) {
    const rawText = msg.text || msg.caption || '';
    const { textOnly, buttons } = parseButtonsBlock(rawText);
    const htmlBlock = buildStyledHtml(session.selectedStyle, textOnly);

    if (session.mode === 'media') {
      session.pending = { kind: 'media', postType: session.postType, mediaId: session.mediaId, html: htmlBlock, buttons: buttons.length ? buttons : null };
    } else {
      session.pending = { kind: 'text', html: htmlBlock, buttons: buttons.length ? buttons : null };
    }
    
    session.state = STATES.WAIT_CONFIRM;
    let previewText = `🧾 <b>Post Preview:</b>\n\n${htmlBlock}`;
    return updateUI(chatId, uid, previewText, CONFIRM_MENU);
  }
});

console.log('Bot is running safely...');
