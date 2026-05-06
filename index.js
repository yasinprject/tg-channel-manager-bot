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
  console.error('Missing Environment Variables! Required: BOT_TOKEN, CHANNEL_ID, OWNER_IDS');
  process.exit(1);
}

function isOwner(uid) {
  return OWNER_IDS.includes(String(uid));
}

// ---------------- EXPRESS (Health) ----------------
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.status(200).send('Channel Manager Pro Bot is Online & Running Perfectly.'));
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
  WAIT_TEXT: 'WAIT_TEXT',
  WAIT_STYLE: 'WAIT_STYLE',
  WAIT_CONFIRM: 'WAIT_CONFIRM',
  WAIT_RAW: 'WAIT_RAW',
  WAIT_SPOILER: 'WAIT_SPOILER',
  WAIT_REPOST: 'WAIT_REPOST',
});

const sessions = Object.create(null);

function defaultSession() {
  return {
    chatId: null,
    state: STATES.IDLE,
    tempRawText: null, // Temporary text before styling
    postType: 'text',
    mediaId: null,
    album: { id: null, items: [], timer: null },
    mediaAlbumItems: null,
    draftBlocks:[],   // Array to hold styled blocks
    draftButtons:[],
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

// ---------------- UTILITIES & ANIMATIONS ----------------
function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function safeDelete(chatId, msgId) {
  try { if (msgId) await bot.deleteMessage(chatId, msgId); } catch (_) {}
}

async function playPublishAnimation(chatId) {
  try {
    const msg = await bot.sendMessage(chatId, `⏳ <b>Publishing</b>`, { parse_mode: 'HTML' });
    await new Promise(r => setTimeout(r, 300));
    await bot.editMessageText(`🚀 <b>Publishing.</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    await bot.editMessageText(`🚀 <b>Publishing...</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }).catch(() => {});
    return msg.message_id;
  } catch (e) { return null; }
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
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
      if (parts.length >= 2 && normalizeUrl(parts[1])) {
        row.push({ text: parts[0].slice(0, 64), url: normalizeUrl(parts[1]) });
      }
    }
    if (row.length) buttons.push(row);
  }
  return { textOnly, buttons };
}

// ---------------- HTML BUILDER (24 STYLES) ----------------
function buildStyledHtml(style, plainText) {
  const text = String(plainText || '');
  const safe = escapeHtml(text);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  if (style === 'link') {
    const parts = text.split('|').map(p => p.trim());
    if (parts.length >= 2 && normalizeUrl(parts[1])) {
      return `<a href="${escapeHtml(normalizeUrl(parts[1]))}">${escapeHtml(parts[0])}</a>`;
    }
    return safe; // fallback
  }

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
    case 'expand_quote': return `<blockquote expandable>${safe}</blockquote>`;
    case 'heading': return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets': return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'numbered': return lines.map((l, i) => `<b>${i + 1}.</b> ${escapeHtml(l)}`).join('\n');
    case 'pros': return lines.map(l => `✅ ${escapeHtml(l)}`).join('\n');
    case 'cons': return lines.map(l => `❌ ${escapeHtml(l)}`).join('\n');
    case 'note': return `📌 <b>Note:</b> ${safe}`;
    case 'warning': return `⚠️ <b>Warning:</b> ${safe}`;
    case 'signature': return `<i>— ${safe}</i>`;
    case 'center': return `──────────────\n<b>${safe}</b>\n──────────────`;
    case 'divider': return `━━━━━━━━━━━━━━━━━━`;
    case 'highlight': return `✨ <b>${safe}</b> ✨`;
    case 'mono_quote': return `<blockquote><code>${safe}</code></blockquote>`;
    default: return safe;
  }
}

// ---------------- MENUS & LAYOUTS (FAB & 3-COLUMN) ----------------

// 1. Initial State (Collapsed FAB)
const MENU_COLLAPSED = {
  inline_keyboard: [[{ text: '✍️ Start Building Post', callback_data: 'start_building' }],
    [{ text: '🛠 Advanced Modes (FAB)', callback_data: 'fab_expand' }]
  ]
};

// 2. Expanded State (FAB Expanded in 3-Columns)
const MENU_EXPANDED = {
  inline_keyboard: [[
      { text: '📝 Raw HTML', callback_data: 'mode_raw' },
      { text: '😶‍🌫️ Spoiler', callback_data: 'mode_spoiler' },
      { text: '🔄 Repost', callback_data: 'mode_repost' }
    ],[
      { text: '🔘 Button Guide', callback_data: 'action_show_button_guide' },
      { text: '❌ Reset Bot', callback_data: 'reset' },
      { text: '⬆️ Hide Modes', callback_data: 'fab_collapse' }
    ]
  ]
};

// 3. Three-Column Styles List
const STYLES =[
  { id: 'normal', text: '🔤 Normal' }, { id: 'title', text: '🏆 Title' }, { id: 'bold', text: 'Bold' },
  { id: 'italic', text: 'Italic' }, { id: 'heading', text: '🔹 Heading' }, { id: 'spoiler', text: '🌫️ Spoiler' },
  { id: 'quote', text: '❝ Quote' }, { id: 'link', text: '🔗 Link' }, { id: 'bullets', text: '• Bullets' },
  { id: 'numbered', text: '1️⃣ Numbered' }, { id: 'pros', text: '✅ Pros' }, { id: 'cons', text: '❌ Cons' },
  { id: 'code', text: 'Code' }, { id: 'pre', text: 'Code Block' }, { id: 'expand_quote', text: '📖 Exp. Quote' },
  { id: 'mono_quote', text: '🧾 Mono' }, { id: 'note', text: '📌 Note' }, { id: 'warning', text: '⚠️ Warn' },
  { id: 'highlight', text: '✨ Highlight' }, { id: 'center', text: '🎯 Center' }, { id: 'strike', text: 'Strike' },
  { id: 'underline', text: 'Underline' }, { id: 'divider', text: '➖ Divider' }, { id: 'signature', text: '✍️ Sign' }
];

function getStyleMenu() {
  const keyboard =[];
  // Chunk styles into rows of 3 (3 columns)
  for (let i = 0; i < STYLES.length; i += 3) {
    const row = [{ text: STYLES[i].text, callback_data: `style_${STYLES[i].id}` }];
    if (STYLES[i + 1]) row.push({ text: STYLES[i + 1].text, callback_data: `style_${STYLES[i + 1].id}` });
    if (STYLES[i + 2]) row.push({ text: STYLES[i + 2].text, callback_data: `style_${STYLES[i + 2].id}` });
    keyboard.push(row);
  }
  keyboard.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: keyboard };
}

// 4. Unified Confirm Menu (Single & Multi design controls here)
function getConfirmMenu(session) {
  const kb =[[
      { text: '✅ Publish Post', callback_data: 'confirm_publish' },
      { text: '➕ Add More Text', callback_data: 'action_add_block' }
    ],[
      { text: '🔕 Silent', callback_data: 'confirm_publish_silent' },
      { text: '📌 Pin', callback_data: 'confirm_publish_pin' },
      { text: '🔇 Silent+Pin', callback_data: 'confirm_publish_silent_pin' }
    ]
  ];

  if (session.draftBlocks.length > 0) {
    kb.push([
      { text: '🎨 Change Last Style', callback_data: 'action_change_last_style' },
      { text: '🗑️ Remove Last Block', callback_data: 'action_undo_last' }
    ]);
  }
  kb.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: kb };
}

function getButtonGuideText() {
  return `🔘 <b>Button Guide</b>\n\nপোস্টের টেক্সটের নিচে বাটন দিতে চাইলে মেসেজের শেষে এইভাবে লিখবেন:\n\n<pre>BUTTONS:\nGoogle | https://google.com\nA | https://a.com || B | https://b.com</pre>\n\n<i>যেকোনো সময় এটি ব্যবহার করতে পারবেন।</i>`;
}

// ---------------- UI UPDATER (SCREEN FRESH FIX) ----------------
async function updateUI(chatId, uid, text, markup) {
  const session = getSession(uid);
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  const payload = { parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) };

  if (session.lastMenuMsgId) {
    await safeDelete(chatId, session.lastMenuMsgId);
    session.lastMenuMsgId = null;
  }
  const sent = await bot.sendMessage(chatId, text, payload);
  session.lastMenuMsgId = sent.message_id;
}

// ---------------- PREVIEW & PUBLISH HELPERS ----------------
function renderPendingPreview(session) {
  const html = session.draftBlocks.join('\n\n');
  const btnStatus = session.draftButtons.length > 0 ? `\n\n<i>Buttons: ✅ Attached</i>` : '';

  if (session.state === STATES.WAIT_RAW || session.state === STATES.WAIT_SPOILER) {
    return `🧾 <b>Preview (Raw/Spoiler):</b>\n\n${html}${btnStatus}`;
  }

  if (session.postType === 'album' && session.mediaAlbumItems) {
    return `🧾 <b>Preview (Album)</b>\n\nItems: <b>${session.mediaAlbumItems.length}</b>\nCaption:\n\n${html || '<i>No caption</i>'}${btnStatus}`;
  }
  
  if (session.mediaId) {
    return `🧾 <b>Preview (Media + Caption)</b>\n\n${html || '<i>No caption</i>'}${btnStatus}`;
  }

  return `🧾 <b>Post Preview:</b>\n\n${html || '<i>Empty</i>'}${btnStatus}`;
}

async function executePublish(session, opts) {
  const html = session.draftBlocks.join('\n\n');
  const sendOpts = {
    parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: opts.silent || false,
    ...(session.draftButtons.length ? { reply_markup: { inline_keyboard: session.draftButtons } } : {})
  };

  let sentMsg;

  if (session.postType === 'text') {
    const MAX = 4096;
    if (html.length <= MAX) {
      sentMsg = await bot.sendMessage(CHANNEL_ID, html, sendOpts);
    } else {
      const parts = html.split(/\n{2,}/g).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        sentMsg = await bot.sendMessage(CHANNEL_ID, parts[i], { ...sendOpts, ...(i !== parts.length - 1 ? { reply_markup: undefined } : {}) });
      }
    }
  } else if (session.postType === 'album') {
    const mediaPayload = session.mediaAlbumItems.map((it, idx) => ({
      type: it.type, media: it.media, ...(idx === 0 && html && !session.draftButtons.length && html.length <= 1024 ? { caption: html, parse_mode: 'HTML' } : {})
    }));
    
    const msgs = await bot.sendMediaGroup(CHANNEL_ID, mediaPayload, { disable_notification: opts.silent });
    sentMsg = msgs[0];
    if (session.draftButtons.length || (html && html.length > 1024)) {
      await bot.sendMessage(CHANNEL_ID, html || '🔗 Links:', sendOpts);
    }
  } else {
    // Single Media
    if (html && !['sticker', 'video_note'].includes(session.postType)) {
      if (html.length > 1024) {
        await bot.sendMessage(CHANNEL_ID, html, sendOpts);
        sendOpts.caption = '';
      } else {
        sendOpts.caption = html;
      }
    }
    if (session.postType === 'photo') sentMsg = await bot.sendPhoto(CHANNEL_ID, session.mediaId, sendOpts);
    else if (session.postType === 'video') sentMsg = await bot.sendVideo(CHANNEL_ID, session.mediaId, sendOpts);
    else if (session.postType === 'document') sentMsg = await bot.sendDocument(CHANNEL_ID, session.mediaId, sendOpts);
    else if (session.postType === 'audio') sentMsg = await bot.sendAudio(CHANNEL_ID, session.mediaId, sendOpts);
    else if (session.postType === 'voice') sentMsg = await bot.sendVoice(CHANNEL_ID, session.mediaId, sendOpts);
    else if (session.postType === 'animation') sentMsg = await bot.sendAnimation(CHANNEL_ID, session.mediaId, sendOpts);
    else if (session.postType === 'sticker') sentMsg = await bot.sendSticker(CHANNEL_ID, session.mediaId, sendOpts);
    else if (session.postType === 'video_note') sentMsg = await bot.sendVideoNote(CHANNEL_ID, session.mediaId, sendOpts);
  }

  if (opts.pin && sentMsg) await bot.pinChatMessage(CHANNEL_ID, sentMsg.message_id, { disable_notification: opts.silent });
}

// ---------------- MEDIA EXTRACTORS ----------------
function extractSingleMedia(msg) {
  if (msg.photo) return { postType: 'photo', mediaId: msg.photo[msg.photo.length - 1].file_id };
  if (msg.video) return { postType: 'video', mediaId: msg.video.file_id };
  if (msg.document) return { postType: 'document', mediaId: msg.document.file_id };
  if (msg.audio) return { postType: 'audio', mediaId: msg.audio.file_id };
  if (msg.voice) return { postType: 'voice', mediaId: msg.voice.file_id };
  if (msg.animation) return { postType: 'animation', mediaId: msg.animation.file_id };
  if (msg.sticker) return { postType: 'sticker', mediaId: msg.sticker.file_id };
  if (msg.video_note) return { postType: 'video_note', mediaId: msg.video_note.file_id };
  return null;
}

function extractAlbumItem(msg) {
  if (msg.photo) return { type: 'photo', media: msg.photo[msg.photo.length - 1].file_id };
  if (msg.video) return { type: 'video', media: msg.video.file_id };
  return null;
}

function scheduleFinalizeAlbum(uid) {
  const session = getSession(uid);
  clearAlbumTimer(session);
  session.album.timer = setTimeout(async () => {
    try {
      session.mediaAlbumItems = session.album.items.slice();
      session.postType = 'album';
      session.mediaId = null;
      
      session.album.id = null; session.album.items =[]; session.album.timer = null;
      session.state = STATES.WAIT_TEXT;
      await updateUI(session.chatId, uid, `✅ <b>Album Received (${session.mediaAlbumItems.length} items)!</b>\n\nএখন ক্যাপশন পাঠাতে পারেন, অথবা চাইলে সরাসরি Publish করতে পারেন:`, getConfirmMenu(session));
    } catch (e) { console.error('Album timeout error:', e); }
  }, 1200);
}

// ---------------- COMMANDS & CALLBACKS ----------------
bot.onText(/^\/(start|menu|cancel|ping)$/i, async (msg, match) => {
  const uid = String(msg.from?.id);
  const chatId = msg.chat.id;
  const cmd = match[1].toLowerCase();
  if (!isOwner(uid) || msg.chat.type !== 'private') return;
  if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

  if (cmd === 'ping') return bot.sendMessage(chatId, '✅ Bot is running with FAB structure.');
  if (cmd === 'cancel') {
    resetSession(uid, true);
    return updateUI(chatId, uid, `✅ Operation Cancelled.`, MENU_COLLAPSED);
  }
  
  resetSession(uid, cmd !== 'start');
  getSession(uid).chatId = chatId;
  
  const welcomeText = `👑 <b>Channel Manager Pro</b>\n\n👇 <b>Smart Auto-Detect:</b>\n• সরাসরি Text, ছবি বা ফাইল সেন্ড করুন।\n• Repost করতে চাইলে Forward করুন।\n\n<i>অথবা Advanced Mode অপশন থেকে শুরু করুন:</i>`;
  await updateUI(chatId, uid, welcomeText, MENU_COLLAPSED);
});

bot.on('callback_query', async (query) => {
  const uid = String(query.from?.id);
  const chatId = query.message.chat.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true });
  bot.answerCallbackQuery(query.id).catch(() => {});
  
  const data = query.data;
  const session = getSession(uid);
  session.chatId = chatId;

  // 1. Reset / Cancel
  if (data === 'cancel' || data === 'reset') {
    resetSession(uid, true);
    return updateUI(chatId, uid, `🏠 <b>Main Menu</b>\n\nঅপারেশন বাতিল করা হয়েছে।`, MENU_COLLAPSED);
  }

  // 2. FAB Menu Toggles
  if (data === 'fab_expand') {
    return updateUI(chatId, uid, `🛠 <b>Advanced Modes Opened:</b>`, MENU_EXPANDED);
  }
  if (data === 'fab_collapse') {
    return updateUI(chatId, uid, `🏠 <b>Main Menu:</b>`, MENU_COLLAPSED);
  }

  // 3. Builder Flow (Single + Multi)
  if (data === 'start_building' || data === 'action_add_block') {
    session.state = STATES.WAIT_TEXT;
    return updateUI(chatId, uid, `✏️ <b>Editor:</b>\n\nআপনার টেক্সট, ছবি বা মিডিয়া সেন্ড করুন:`, CANCEL_MENU);
  }

  if (data.startsWith('style_')) {
    const styleId = data.replace('style_', '');
    let finalBlock = buildStyledHtml(styleId, session.tempRawText);
    
    // Add block to draft
    session.draftBlocks.push(finalBlock);
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }

  if (data === 'action_change_last_style') {
    if (session.draftBlocks.length > 0) session.draftBlocks.pop(); // Remove last to redo
    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `🎨 <b>Change Style:</b>\n\nনতুন স্টাইল সিলেক্ট করুন:`, getStyleMenu());
  }

  if (data === 'action_undo_last') {
    if (session.draftBlocks.length > 0) session.draftBlocks.pop();
    if (session.draftBlocks.length === 0) session.draftButtons =[];
    return updateUI(chatId, uid, `↩️ <b>Undo done.</b>\n\n${renderPendingPreview(session)}`, getConfirmMenu(session));
  }

  // 4. Advanced Modes from FAB
  if (data === 'mode_raw' || data === 'mode_spoiler') {
    session.state = data === 'mode_raw' ? STATES.WAIT_RAW : STATES.WAIT_SPOILER;
    return updateUI(chatId, uid, `📝 <b>${data === 'mode_raw' ? 'Raw HTML' : 'Spoiler'} Mode</b>\n\nটেক্সট পাঠান:`, CANCEL_MENU);
  }
  if (data === 'mode_repost') {
    session.state = STATES.WAIT_REPOST;
    return updateUI(chatId, uid, `🔄 <b>Repost Mode</b>\n\nমেসেজ Forward করুন:`, CANCEL_MENU);
  }
  if (data === 'action_show_button_guide') {
    return updateUI(chatId, uid, getButtonGuideText(), { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'fab_expand' }]] });
  }

  // 5. Publish Actions
  if (data.startsWith('confirm_publish')) {
    try {
      const isSilent = data.includes('silent');
      const isPin = data.includes('pin');
      
      const animMsgId = await playPublishAnimation(chatId);
      await executePublish(session, { silent: isSilent, pin: isPin });
      await safeDelete(chatId, animMsgId);
      
      resetSession(uid, true);
      return updateUI(chatId, uid, `✅ <b>Successfully Published to Channel!</b> 🎉`, MENU_COLLAPSED);
    } catch (e) {
      return updateUI(chatId, uid, `❌ <b>Publish Failed:</b> ${escapeHtml(e.message)}`, CANCEL_MENU);
    }
  }
});

// ---------------- MESSAGE HANDLER ----------------
bot.on('message', async (msg) => {
  const uid = String(msg.from?.id);
  if (!isOwner(uid) || msg.from?.is_bot || msg.chat.type !== 'private') return;
  if (msg.text && /^\/(start|menu|cancel|ping)/i.test(msg.text)) return;

  const chatId = msg.chat.id;
  const session = getSession(uid);
  session.chatId = chatId;

  // Repost Auto-Detect
  if (session.state === STATES.WAIT_REPOST || (session.state === STATES.IDLE && (msg.forward_from || msg.forward_from_chat || msg.forward_origin || msg.forward_date))) {
    try {
      if (bot.copyMessage) await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      else await bot.forwardMessage(CHANNEL_ID, chatId, msg.message_id);
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      resetSession(uid, true);
      return updateUI(chatId, uid, `✅ <b>Message Reposted Successfully!</b> 🚀`, MENU_COLLAPSED);
    } catch (e) {
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return updateUI(chatId, uid, `❌ <b>Copy failed:</b> Protected content.`, CANCEL_MENU);
    }
  }

  // Detect Media (Album / Single) everywhere except specific modes
  if ([STATES.IDLE, STATES.WAIT_TEXT].includes(session.state)) {
    if (msg.media_group_id) {
      const item = extractAlbumItem(msg);
      if (item) {
        if (session.album.id !== msg.media_group_id) { clearAlbumTimer(session); session.album.id = msg.media_group_id; session.album.items =[]; }
        session.album.items.push(item);
        if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
        return scheduleFinalizeAlbum(uid);
      }
    } else {
      const media = extractSingleMedia(msg);
      if (media) {
        session.mediaId = media.mediaId;
        session.postType = media.postType;
        session.mediaAlbumItems = null;
        if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
        
        if (['sticker', 'video_note'].includes(session.postType)) {
          session.state = STATES.WAIT_CONFIRM;
          return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
        }
        
        session.state = STATES.WAIT_TEXT;
        return updateUI(chatId, uid, `✅ <b>Media Detected!</b>\n\nএখন টেক্সট/ক্যাপশন পাঠাতে পারেন, অথবা সরাসরি Publish করতে পারেন:`, getConfirmMenu(session));
      }
    }
  }

  if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
  const rawText = msg.text || msg.caption || '';
  if (!rawText.trim()) return;

  const { textOnly, buttons } = parseButtonsBlock(rawText);
  if (buttons.length) session.draftButtons = buttons;

  // Raw or Spoiler logic
  if (session.state === STATES.WAIT_RAW || session.state === STATES.WAIT_SPOILER) {
    session.draftBlocks.push(session.state === STATES.WAIT_SPOILER ? `<tg-spoiler>${escapeHtml(textOnly)}</tg-spoiler>` : textOnly);
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }

  // Unified Text Builder logic
  if (session.state === STATES.IDLE || session.state === STATES.WAIT_TEXT) {
    session.tempRawText = textOnly;
    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `🎨 <b>Select Style:</b>\n\nটেক্সটটির জন্য স্টাইল নির্বাচন করুন:`, getStyleMenu());
  }
});

// ---------------- STARTUP ----------------
async function startBot() {
  console.log('Starting Master Bot...');
  await bot.deleteWebHook().catch(() => {});
  await bot.startPolling();
  await bot.setMyCommands([{ command: 'start', description: 'Start' }, { command: 'menu', description: 'Menu' }]);
  console.log('Bot is live with Unified Builder & FAB Grid UI!');
}
startBot();
