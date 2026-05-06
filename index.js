'use strict';

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = Number(process.env.PORT || 3000);
const GHOST_MODE = String(process.env.GHOST_MODE ?? 'true').toLowerCase() === 'true';

const OWNER_IDS = (process.env.OWNER_IDS || process.env.OWNER_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN || !CHANNEL_ID || OWNER_IDS.length === 0) {
  console.error('Missing Environment Variables! Required: BOT_TOKEN, CHANNEL_ID, OWNER_IDS/OWNER_ID');
  process.exit(1);
}

function isOwner(uid) {
  return OWNER_IDS.includes(String(uid));
}

// ---------------- EXPRESS (Health) ----------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Channel Manager Pro Bot is Online & Running Perfectly.');
});

const server = app.listen(PORT, () => console.log(`Health server running on :${PORT}`));

server.on('error', (err) => {
  console.error('Express server error:', err?.message || err);
  process.exit(1);
});

// ---------------- BOT ----------------
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { autoStart: false, interval: 300, params: { timeout: 10 } },
});

bot.on('polling_error', (err) => console.error('Polling error:', err?.message || err));
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
    draftBlocks:[],
    draftButtons:[],
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

// ---------------- UTILITIES & ANIMATION ----------------
function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function safeDelete(chatId, msgId) {
  try { if (msgId) await bot.deleteMessage(chatId, msgId); } catch (_) {}
}

// NEW: Publishing Animation Helper
async function playPublishAnimation(chatId) {
  try {
    const msg = await bot.sendMessage(chatId, `⏳ <b>Publishing</b>`, { parse_mode: 'HTML' });
    await new Promise(r => setTimeout(r, 300));
    await bot.editMessageText(`🚀 <b>Publishing.</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    await bot.editMessageText(`🚀 <b>Publishing...</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }).catch(() => {});
    return msg.message_id;
  } catch (e) {
    return null;
  }
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch { return null; }
}

function parseButtonsBlock(inputText) {
  const raw = String(inputText || '');
  const lines = raw.split('\n');
  const markerIndex = lines.findIndex(l => l.trim().toUpperCase() === 'BUTTONS:');
  if (markerIndex === -1) return { textOnly: raw.trim(), buttons:[] };

  const textOnly = lines.slice(0, markerIndex).join('\n').trim();
  const btnLines = lines.slice(markerIndex + 1).map(l => l.trim()).filter(Boolean);
  const buttons =[];

  for (const line of btnLines) {
    const rowButtons = line.split('||').map(b => b.trim()).filter(Boolean);
    const row =[];
    for (const btn of rowButtons) {
      const parts = btn.split('|').map(p => p.trim());
      if (parts.length < 2) continue;
      const label = parts[0], url = normalizeUrl(parts[1]);
      if (label && url) row.push({ text: label.slice(0, 64), url });
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
    case 'normal': return safe;
    case 'title': return `🏆 <b>${escapeHtml(text.toUpperCase())}</b>\n━━━━━━━━━━━━━━━━━`;
    case 'bold': return `<b>${safe}</b>`;
    case 'italic': return `<i>${safe}</i>`;
    case 'underline': return `<u>${safe}</u>`;
    case 'strike': return `<s>${safe}</s>`;
    case 'spoiler': return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code': return `<code>${safe}</code>`;
    case 'pre': return `<pre>${safe}</pre>`;
    case 'quote': return `<blockquote>${safe}</blockquote>`;
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

function buildStylePreview(style) {
  if (style === 'link') return `<a href="https://google.com">Google</a>`;
  return buildStyledHtml(style, 'এটি স্টাইলের একটি ডেমো উদাহরণ');
}

// ---------------- MENUS ----------------
const MAIN_MENU = {
  inline_keyboard:[[{ text: '⚡ Quick Text', callback_data: 'mode_quick' }, { text: '🧱 Multi Block', callback_data: 'mode_multi' }],[{ text: '📎 Media / Album', callback_data: 'mode_media' }, { text: '📝 Raw HTML', callback_data: 'mode_raw' }],[{ text: '😶‍🌫️ Spoiler', callback_data: 'mode_spoiler' }, { text: '🔄 Repost', callback_data: 'mode_repost' }],[{ text: '❌ Reset Bot', callback_data: 'reset' }],
  ],
};

const CANCEL_MENU = { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'cancel' }]] };

function getConfirmMenu(session) {
  const kb = [[
      { text: '✅ Publish', callback_data: 'confirm_publish' },
      { text: '🔕 Silent', callback_data: 'confirm_publish_silent' },
      { text: '📌 Pin', callback_data: 'confirm_publish_pin' }
    ]
  ];
  if (session.mode === 'quick' && session.pending?.rawHtml) {
    kb.push([{ text: '🎨 Change Style', callback_data: 'confirm_change_style' }, { text: '✏️ Edit Text', callback_data: 'confirm_edit' }]);
  } else {
    kb.push([{ text: '✏️ Edit Again', callback_data: 'confirm_edit' }]);
  }
  kb.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: kb };
}

const STYLES =[
  { id: 'normal', text: 'Normal 🔤' }, { id: 'title', text: '🏆 Title' },
  { id: 'bold', text: 'Bold' }, { id: 'italic', text: 'Italic' },
  { id: 'code', text: 'Code' }, { id: 'pre', text: 'Code Block' },
  { id: 'quote', text: '❝ Quote' }, { id: 'bullets', text: '• Bullets' },
  { id: 'pros', text: '✅ Pros' }, { id: 'cons', text: '❌ Cons' },
  { id: 'note', text: '📌 Note' }, { id: 'divider', text: '➖ Divider' }
];

function getStyleMenu(session) {
  const keyboard =[];
  const hasMedia = Boolean(session.mediaId) || Boolean(session.mediaAlbumItems);
  if (session.mode === 'media' && hasMedia) {
    keyboard.push([{ text: '🚀 Skip Caption (Direct Post)', callback_data: 'action_skip_caption' }]);
  }
  for (let i = 0; i < STYLES.length; i += 2) {
    keyboard.push([
      { text: STYLES[i].text, callback_data: `style_${STYLES[i].id}` },
      ...(STYLES[i + 1] ? [{ text: STYLES[i + 1].text, callback_data: `style_${STYLES[i + 1].id}` }] :[]),
    ]);
  }
  if (session.mode === 'multi' && session.draftBlocks.length > 0) {
    keyboard.push([{ text: `🚀 Publish (${session.draftBlocks.length} blocks)`, callback_data: 'action_publish' }]);
  }
  keyboard.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: keyboard };
}

// ---------------- UI UPDATER (SCREEN FRESH FIX) ----------------
async function updateUI(chatId, uid, text, markup) {
  const session = getSession(uid);
  bot.sendChatAction(chatId, 'typing').catch(() => {}); // Chat Action Animation

  const payload = { parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) };
  
  if (session.lastMenuMsgId) {
    await safeDelete(chatId, session.lastMenuMsgId);
    session.lastMenuMsgId = null;
  }
  const sent = await bot.sendMessage(chatId, text, payload);
  session.lastMenuMsgId = sent.message_id;
}

// ---------------- PUBLISH HELPERS ----------------
async function executePublish(session, opts) {
  const p = session.pending;
  const sendOpts = {
    parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: opts.silent || false,
    ...(p.buttons ? { reply_markup: p.buttons } : {})
  };

  let sentMsg;
  if (p.kind === 'text') sentMsg = await bot.sendMessage(CHANNEL_ID, p.html, sendOpts);
  else if (p.kind === 'media') {
    if (p.html) sendOpts.caption = p.html;
    if (p.postType === 'photo') sentMsg = await bot.sendPhoto(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'video') sentMsg = await bot.sendVideo(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'document') sentMsg = await bot.sendDocument(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'audio') sentMsg = await bot.sendAudio(CHANNEL_ID, p.mediaId, sendOpts);
  } else if (p.kind === 'album') {
    const msgs = await bot.sendMediaGroup(CHANNEL_ID, p.items.map((it, idx) => ({
      type: it.type, media: it.media, ...(idx === 0 && p.html ? { caption: p.html, parse_mode: 'HTML' } : {})
    })), { disable_notification: opts.silent });
    sentMsg = msgs[0];
    if (p.buttons) await bot.sendMessage(CHANNEL_ID, '🔗 Links:', sendOpts);
  }
  
  if (opts.pin && sentMsg) await bot.pinChatMessage(CHANNEL_ID, sentMsg.message_id, { disable_notification: opts.silent });
}

function renderPendingPreview(session) {
  const p = session.pending;
  if (!p) return 'No preview available.';
  if (p.kind === 'album') return `🧾 <b>Preview (Album)</b>\n\nItems: <b>${p.items.length}</b>\nCaption: ${p.html ? '✅' : '❌'}`;
  return `🧾 <b>Preview</b>\n\n${p.html}`;
}

// ---------------- COMMANDS & CALLBACKS ----------------
bot.onText(/^\/(start|menu)$/i, async (msg) => {
  const uid = String(msg.from?.id);
  const chatId = msg.chat.id;
  if (!isOwner(uid)) return;
  if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
  
  resetSession(uid, false);
  getSession(uid).chatId = chatId;
  await updateUI(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\n💡 <i>টিপস: কোনো মোড সিলেক্ট না করেও সরাসরি টেক্সট বা ছবি পাঠিয়ে পোস্ট করতে পারেন!</i>\n\nএকটি মোড নির্বাচন করুন:`, MAIN_MENU);
});

bot.on('callback_query', async (query) => {
  const uid = String(query.from?.id);
  const chatId = query.message.chat.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true });
  
  bot.answerCallbackQuery(query.id).catch(() => {});
  const data = query.data;
  const session = getSession(uid);
  session.chatId = chatId;

  if (data === 'cancel' || data === 'reset') {
    resetSession(uid, false);
    return updateUI(chatId, uid, `🏠 <b>Main Menu</b>\n\nঅপারেশন বাতিল করা হয়েছে।`, MAIN_MENU);
  }

  // Publish Logic with Animation
  if (data.startsWith('confirm_publish')) {
    try {
      const isSilent = data.includes('silent');
      const isPin = data.includes('pin');
      
      const animMsgId = await playPublishAnimation(chatId); // Start Loading Animation
      await executePublish(session, { silent: isSilent, pin: isPin });
      await safeDelete(chatId, animMsgId); // Delete Animation Message
      
      resetSession(uid, false);
      return updateUI(chatId, uid, `✅ <b>Successfully Published to Channel!</b> 🎉`, MAIN_MENU);
    } catch (e) {
      return updateUI(chatId, uid, `❌ <b>Publish Failed:</b> ${escapeHtml(e.message)}`, CANCEL_MENU);
    }
  }

  if (data === 'confirm_change_style') {
    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `🎨 <b>Change Style</b>\n\nনতুন স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
  }

  if (data === 'confirm_edit') {
    session.state = STATES.WAIT_TEXT;
    return updateUI(chatId, uid, `✏️ <b>Edit Text:</b>\n\nনতুন করে টেক্সট লিখে পাঠান।`, CANCEL_MENU);
  }

  if (data.startsWith('mode_')) {
    const selectedMode = data.replace('mode_', '');
    resetSession(uid, false);
    const s = getSession(uid);
    s.chatId = chatId;
    s.mode = selectedMode;

    if (selectedMode === 'quick' || selectedMode === 'multi') {
      s.state = STATES.WAIT_STYLE;
      s.postType = 'text';
      return updateUI(chatId, uid, `🎨 <b>${selectedMode === 'quick' ? 'Quick' : 'Multi-Block'} Mode</b>\n\nস্টাইল নির্বাচন করুন:`, getStyleMenu(s));
    }
    if (selectedMode === 'media') {
      s.state = STATES.WAIT_MEDIA;
      return updateUI(chatId, uid, `📎 <b>Media Mode</b>\n\nছবি, ভিডিও বা ডকুমেন্ট পাঠান:`, CANCEL_MENU);
    }
  }

  if (data.startsWith('style_')) {
    session.previewStyle = data.replace('style_', '');
    session.state = STATES.WAIT_STYLE_PREVIEW;
    return updateUI(chatId, uid, `👀 <b>Style Preview:</b>\n\n${buildStylePreview(session.previewStyle)}\n\n<i>এই স্টাইলটি ব্যবহার করবেন?</i>`, {
      inline_keyboard: [[{ text: '✅ Use This Style', callback_data: 'action_use_previewed_style' }],[{ text: '🔙 Back', callback_data: 'action_back_to_styles' }]]
    });
  }

  if (data === 'action_use_previewed_style') {
    session.selectedStyle = session.previewStyle;
    session.previewStyle = null;

    // Smart Text Re-styling System
    if (session.pending && session.pending.rawHtml && session.mode === 'quick') {
      session.pending.html = buildStyledHtml(session.selectedStyle, session.pending.rawHtml);
      session.state = STATES.WAIT_CONFIRM;
      return updateUI(chatId, uid, `✨ <b>Style Applied!</b>\n\n${renderPendingPreview(session)}`, getConfirmMenu(session));
    }

    session.state = STATES.WAIT_TEXT;
    return updateUI(chatId, uid, `✏️ <b>Editor:</b>\n\nএখন আপনার টেক্সট লিখে পাঠান।`, CANCEL_MENU);
  }

  if (data === 'action_back_to_styles') {
    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `🎨 <b>Choose a style:</b>`, getStyleMenu(session));
  }

  if (data === 'action_skip_caption') {
    session.pending = { kind: session.postType === 'album' ? 'album' : 'media', postType: session.postType, mediaId: session.mediaId, items: session.mediaAlbumItems, html: '', buttons: null, previewHtmlMode: true };
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, `🧾 <b>Ready to Publish!</b>\n(Without Caption)`, getConfirmMenu(session));
  }
});

// ---------------- MESSAGE HANDLER (SMART INPUT) ----------------
bot.on('message', async (msg) => {
  const uid = String(msg.from?.id);
  if (!isOwner(uid) || msg.from?.is_bot || msg.chat.type !== 'private') return;
  if (msg.text && msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const session = getSession(uid);
  session.chatId = chatId;

  // SMART AUTO-POST DETECTION
  if (session.state === STATES.IDLE) {
    if (msg.text) {
      session.mode = 'quick';
      const { textOnly, buttons } = parseButtonsBlock(msg.text);
      session.pending = { kind: 'text', rawHtml: textOnly, html: escapeHtml(textOnly), buttons: buttons.length ? { inline_keyboard: buttons } : null, previewHtmlMode: true };
      session.selectedStyle = 'normal';
      session.state = STATES.WAIT_CONFIRM;
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return updateUI(chatId, uid, `⚡ <b>Smart Input Detected!</b>\n\n${renderPendingPreview(session)}`, getConfirmMenu(session));
    }
    else if (msg.photo || msg.video || msg.document || msg.audio || msg.voice || msg.animation) {
      session.mode = 'media';
      session.state = STATES.WAIT_MEDIA;
      // Do not return! Let it fall through to media processor below.
    } else {
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return;
    }
  }

  if (session.state === STATES.WAIT_MEDIA) {
    if (msg.photo) { session.mediaId = msg.photo.pop().file_id; session.postType = 'photo'; }
    else if (msg.video) { session.mediaId = msg.video.file_id; session.postType = 'video'; }
    else if (msg.document) { session.mediaId = msg.document.file_id; session.postType = 'document'; }
    else return;
    
    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `✅ <b>Media Detected!</b>\n\nএখন Caption Style নির্বাচন করুন:`, getStyleMenu(session));
  }

  if (session.state === STATES.WAIT_TEXT) {
    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
    const rawText = msg.text || msg.caption || '';
    const { textOnly, buttons } = parseButtonsBlock(rawText);
    const htmlBlock = buildStyledHtml(session.selectedStyle, textOnly);
    const replyMarkup = buttons.length ? { inline_keyboard: buttons } : null;

    if (session.mode === 'media') {
      session.pending = { kind: 'media', postType: session.postType, mediaId: session.mediaId, html: htmlBlock, buttons: replyMarkup, previewHtmlMode: true };
    } else {
      session.pending = { kind: 'text', rawHtml: textOnly, html: htmlBlock, buttons: replyMarkup, previewHtmlMode: true };
    }
    
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }
});

// ---------------- STARTUP ----------------
async function startBot() {
  console.log('Starting Bot...');
  await bot.deleteWebHook().catch(() => {});
  await bot.startPolling();
  await bot.setMyCommands([{ command: 'start', description: 'Open Main Menu / Restart' }, { command: 'menu', description: 'Open Menu' }]);
  console.log('Bot is live and running perfectly!');
}
startBot();
