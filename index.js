'use strict';

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = Number(process.env.PORT || 3000);

// ID Authentication
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
app.get('/', (req, res) => res.status(200).send('Master Bot is Online & Running with Clean UI.'));
app.listen(PORT, () => console.log(`Health server running on :${PORT}`));

// ---------------- BOT INITIALIZATION ----------------
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { autoStart: false, interval: 300, params: { timeout: 10 } },
});

process.on('unhandledRejection', e => console.error('UnhandledRejection:', e));
process.on('uncaughtException', e => console.error('UncaughtException:', e));

// ---------------- SESSION & STATES ----------------
const STATES = Object.freeze({
  IDLE: 'IDLE',
  WAIT_TEXT: 'WAIT_TEXT',
  WAIT_STYLE: 'WAIT_STYLE',
  WAIT_CONFIRM: 'WAIT_CONFIRM',
  WAIT_RAW: 'WAIT_RAW',
  WAIT_MEDIA: 'WAIT_MEDIA',
  WAIT_REPOST: 'WAIT_REPOST',
});

const sessions = Object.create(null);

function getSession(uid) {
  if (!sessions[uid]) {
    sessions[uid] = {
      chatId: null,
      state: STATES.IDLE,
      tempRawText: null,
      postType: 'text',
      mediaId: null,
      album: { id: null, items:[], timer: null },
      mediaAlbumItems: null,
      draftBlocks: [],
      draftButtons:[],
      lastBotMsgId: null, // Track bot's ONLY active message
    };
  }
  return sessions[uid];
}

function resetSession(uid, keepLastMsg = true) {
  const lastMsg = sessions[uid]?.lastBotMsgId ?? null;
  const chatId = sessions[uid]?.chatId ?? null;
  if (sessions[uid]?.album?.timer) clearTimeout(sessions[uid].album.timer);
  
  sessions[uid] = getSession('dummy'); // get default
  sessions[uid] = { ...sessions['dummy'], chatId: chatId, lastBotMsgId: keepLastMsg ? lastMsg : null };
  delete sessions['dummy'];
}

// ---------------- UTILITIES (CLEAN SCREEN LOGIC) ----------------
function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function safeDelete(chatId, msgId) {
  try { if (msgId) await bot.deleteMessage(chatId, msgId); } catch (_) {}
}

// 🌟 THE MAGIC FUNCTION: Ensures only ONE bot message exists at any time
async function updateUI(chatId, uid, text, markup) {
  const session = getSession(uid);
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  // Delete the bot's previous message to keep screen completely fresh
  if (session.lastBotMsgId) {
    await safeDelete(chatId, session.lastBotMsgId);
    session.lastBotMsgId = null;
  }

  const payload = { parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) };
  const sent = await bot.sendMessage(chatId, text, payload);
  session.lastBotMsgId = sent.message_id;
}

// Animation for Publishing
async function playPublishAnimation(chatId, uid) {
  const session = getSession(uid);
  if (session.lastBotMsgId) await safeDelete(chatId, session.lastBotMsgId);
  
  try {
    const msg = await bot.sendMessage(chatId, `⏳ <b>Processing...</b>`, { parse_mode: 'HTML' });
    await new Promise(r => setTimeout(r, 400));
    await bot.editMessageText(`🚀 <b>Publishing to Channel...</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' }).catch(() => {});
    return msg.message_id;
  } catch (e) { return null; }
}

// Button Parser (Format: Name | Link || Name | Link)
function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return null; }
}

function parseButtonsBlock(inputText) {
  const lines = String(inputText || '').split('\n');
  const marker = lines.findIndex(l => l.trim().toUpperCase() === 'BUTTONS:');
  if (marker === -1) return { textOnly: inputText.trim(), buttons:[] };

  const textOnly = lines.slice(0, marker).join('\n').trim();
  const buttons =[];
  for (const line of lines.slice(marker + 1).filter(l => l.trim())) {
    const row = line.split('||').map(b => b.trim()).filter(Boolean).map(btn => {
      const parts = btn.split('|').map(p => p.trim());
      if (parts.length >= 2 && normalizeUrl(parts[1])) return { text: parts[0].slice(0, 64), url: normalizeUrl(parts[1]) };
      return null;
    }).filter(Boolean);
    if (row.length) buttons.push(row);
  }
  return { textOnly, buttons };
}

// ---------------- STYLES ENGINE (24 PRO STYLES) ----------------
const STYLES_LIST =[
  { id: 'normal', icon: '🔤', text: 'Normal' }, { id: 'title', icon: '🏆', text: 'Title' }, { id: 'bold', icon: '𝐁', text: 'Bold' },
  { id: 'italic', icon: '𝐼', text: 'Italic' }, { id: 'heading', icon: '🔹', text: 'Heading' }, { id: 'spoiler', icon: '🌫', text: 'Spoiler' },
  { id: 'quote', icon: '❝', text: 'Quote' }, { id: 'expand_quote', icon: '📖', text: 'Exp Quote' }, { id: 'link', icon: '🔗', text: 'Link' },
  { id: 'bullets', icon: '•', text: 'Bullets' }, { id: 'numbered', icon: '1️⃣', text: 'Numbered' }, { id: 'pros', icon: '✅', text: 'Pros' },
  { id: 'cons', icon: '❌', text: 'Cons' }, { id: 'code', icon: '💻', text: 'Code' }, { id: 'pre', icon: '🧾', text: 'Block' },
  { id: 'mono_quote', icon: '📜', text: 'Mono Qt' }, { id: 'note', icon: '📌', text: 'Note' }, { id: 'warning', icon: '⚠️', text: 'Warn' },
  { id: 'highlight', icon: '✨', text: 'Highlight' }, { id: 'center', icon: '🎯', text: 'Center' }, { id: 'strike', icon: '<s>', text: 'Strike' },
  { id: 'underline', icon: 'U', text: 'Underline' }, { id: 'divider', icon: '➖', text: 'Divider' }, { id: 'signature', icon: '✍️', text: 'Sign' }
];

function buildStyledHtml(style, text) {
  const safe = escapeHtml(text || '');
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);

  if (style === 'link') {
    const parts = (text || '').split('|').map(p => p.trim());
    return (parts.length >= 2 && normalizeUrl(parts[1])) ? `<a href="${escapeHtml(normalizeUrl(parts[1]))}">${escapeHtml(parts[0])}</a>` : safe;
  }

  switch (style) {
    case 'normal': return safe;
    case 'title': return `🏆 <b>${escapeHtml((text||'').toUpperCase())}</b>\n━━━━━━━━━━━━━━━━━`;
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

// ---------------- MENUS (COMPACT 3-COLUMN) ----------------
function getStyleMenu(session) {
  const kb =[];
  if (session.mediaId || session.mediaAlbumItems) kb.push([{ text: '🚀 Skip Caption & Use Original Media', callback_data: 'action_skip_caption' }]);

  // 3-Column Layout
  for (let i = 0; i < STYLES_LIST.length; i += 3) {
    const row =[];
    for(let j=0; j<3; j++) {
      if(STYLES_LIST[i+j]) row.push({ text: `${STYLES_LIST[i+j].icon} ${STYLES_LIST[i+j].text}`, callback_data: `style_${STYLES_LIST[i+j].id}` });
    }
    kb.push(row);
  }

  kb.push([{ text: '❌ Cancel & Clear Screen', callback_data: 'clear_screen' }]);
  return { inline_keyboard: kb };
}

function getConfirmMenu(session) {
  const kb = [[{ text: '✅ Publish Post', callback_data: 'pub_normal' }, { text: '➕ Add Block', callback_data: 'action_add_block' }],[{ text: '🔕 Silent', callback_data: 'pub_silent' }, { text: '📌 Pin', callback_data: 'pub_pin' }, { text: '🔇 S+Pin', callback_data: 'pub_spin' }]
  ];
  if (session.draftBlocks.length > 0) kb.push([{ text: '↩️ Undo Last Block', callback_data: 'action_undo_last' }]);
  kb.push([{ text: '❌ Cancel & Clear Screen', callback_data: 'clear_screen' }]);
  return { inline_keyboard: kb };
}

function renderPendingPreview(session) {
  const html = session.draftBlocks.join('\n\n');
  const btns = session.draftButtons.length ? '\n\n<i>[Buttons Attached ✅]</i>' : '';
  if (session.mediaAlbumItems) return `🧾 <b>Album Preview (${session.mediaAlbumItems.length} items):</b>\n\n${html || '<i>No caption</i>'}${btns}`;
  if (session.mediaId) return `🧾 <b>Media Preview:</b>\n\n${html || '<i>No caption</i>'}${btns}`;
  return `🧾 <b>Post Preview:</b>\n\n──────────────\n${html || '<i>Empty</i>'}\n──────────────${btns}`;
}

// ---------------- PUBLISHING LOGIC ----------------
async function executePublish(session, opts) {
  const html = session.draftBlocks.join('\n\n');
  const sendOpts = { parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: opts.silent || false, ...(session.draftButtons.length ? { reply_markup: { inline_keyboard: session.draftButtons } } : {}) };
  let sentMsg;

  if (session.postType === 'text') {
    sentMsg = await bot.sendMessage(CHANNEL_ID, html, sendOpts);
  } else if (session.postType === 'album') {
    const mediaPayload = session.mediaAlbumItems.map((it, idx) => ({ type: it.type, media: it.media, ...(idx === 0 && html && !session.draftButtons.length && html.length <= 1024 ? { caption: html, parse_mode: 'HTML' } : {}) }));
    const msgs = await bot.sendMediaGroup(CHANNEL_ID, mediaPayload, { disable_notification: opts.silent });
    sentMsg = msgs[0];
    if (session.draftButtons.length || (html && html.length > 1024)) await bot.sendMessage(CHANNEL_ID, html || '🔗 Links:', sendOpts);
  } else {
    if (html && !['sticker', 'video_note'].includes(session.postType)) {
      if (html.length > 1024) { await bot.sendMessage(CHANNEL_ID, html, sendOpts); sendOpts.caption = ''; } else sendOpts.caption = html;
    }
    const mId = session.mediaId;
    if (session.postType === 'photo') sentMsg = await bot.sendPhoto(CHANNEL_ID, mId, sendOpts);
    else if (session.postType === 'video') sentMsg = await bot.sendVideo(CHANNEL_ID, mId, sendOpts);
    else if (session.postType === 'document') sentMsg = await bot.sendDocument(CHANNEL_ID, mId, sendOpts);
    else if (session.postType === 'audio') sentMsg = await bot.sendAudio(CHANNEL_ID, mId, sendOpts);
    else if (session.postType === 'voice') sentMsg = await bot.sendVoice(CHANNEL_ID, mId, sendOpts);
    else if (session.postType === 'animation') sentMsg = await bot.sendAnimation(CHANNEL_ID, mId, sendOpts);
    else if (session.postType === 'sticker') sentMsg = await bot.sendSticker(CHANNEL_ID, mId, sendOpts);
  }

  if (opts.pin && sentMsg) await bot.pinChatMessage(CHANNEL_ID, sentMsg.message_id, { disable_notification: opts.silent });
}

// ---------------- CALLBACK QUERY HANDLER ----------------
bot.on('callback_query', async (query) => {
  const uid = String(query.from.id);
  const chatId = query.message.chat.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
  bot.answerCallbackQuery(query.id).catch(() => {});
  
  const data = query.data;
  const session = getSession(uid);
  session.chatId = chatId;

  if (data === 'clear_screen') {
    resetSession(uid, false);
    if (session.lastBotMsgId) await safeDelete(chatId, session.lastBotMsgId);
    return; // Leaves screen 100% blank!
  }

  if (data.startsWith('pub_')) {
    const isSilent = data.includes('silent') || data === 'pub_spin';
    const isPin = data.includes('pin') || data === 'pub_spin';
    
    const animId = await playPublishAnimation(chatId, uid);
    try {
      await executePublish(session, { silent: isSilent, pin: isPin });
      resetSession(uid, false);
      await safeDelete(chatId, animId);
      // Final Success Message with Clear Button
      const successMsg = await bot.sendMessage(chatId, `✅ <b>Successfully Published!</b>\n\n<i>You can clear this message to keep your chat completely empty.</i>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🧹 Clear Screen', callback_data: 'clear_screen' }]] } });
      getSession(uid).lastBotMsgId = successMsg.message_id;
    } catch (e) {
      await safeDelete(chatId, animId);
      return updateUI(chatId, uid, `❌ <b>Failed:</b> ${e.message}`, { inline_keyboard: [[{ text: '🧹 Clear Screen', callback_data: 'clear_screen' }]] });
    }
    return;
  }

  if (data === 'action_add_block') {
    session.state = STATES.WAIT_TEXT;
    return updateUI(chatId, uid, `✏️ <b>Next Block:</b>\n\nটেক্সট সেন্ড করুন:`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'clear_screen' }]] });
  }

  if (data.startsWith('style_')) {
    const styleId = data.replace('style_', '');
    session.draftBlocks.push(buildStyledHtml(styleId, session.tempRawText));
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }

  if (data === 'action_undo_last') {
    session.draftBlocks.pop();
    if (!session.draftBlocks.length) session.draftButtons =[];
    if (!session.draftBlocks.length && !session.mediaId) {
      resetSession(uid, true);
      return updateUI(chatId, uid, `🧹 Draft Cleared.`, { inline_keyboard: [[{ text: '🧹 Clear Screen', callback_data: 'clear_screen' }]] });
    }
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }

  if (data === 'action_skip_caption') {
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }
});

// ---------------- MESSAGE HANDLER (GHOST MODE & MENU COMMANDS) ----------------
bot.on('message', async (msg) => {
  const uid = String(msg.from?.id);
  const chatId = msg.chat.id;
  if (!isOwner(uid) || msg.chat.type !== 'private') return;

  // 1. Instantly delete user's message (Ghost Mode) to keep screen perfectly clean
  await safeDelete(chatId, msg.message_id);

  const session = getSession(uid);
  session.chatId = chatId;

  // 2. Command Handlers (Triggered by Bottom Menu Button or typing)
  if (msg.text?.startsWith('/')) {
    const cmd = msg.text.split(' ')[0].toLowerCase();
    
    if (cmd === '/cancel' || cmd === '/start') {
      resetSession(uid, true);
      if (cmd === '/cancel') return updateUI(chatId, uid, `🧹 Action Cancelled.`, { inline_keyboard: [[{ text: '🧹 Clear Screen', callback_data: 'clear_screen' }]] });
      return updateUI(chatId, uid, `👑 <b>Master Bot Ready.</b>\n\n<i>Use the Bottom <b>Menu (↙️)</b> button to select a mode, or send text/media directly!</i>`, { inline_keyboard: [[{ text: '🧹 Clear Screen', callback_data: 'clear_screen' }]] });
    }
    
    if (cmd === '/text') {
      resetSession(uid, true);
      session.state = STATES.WAIT_TEXT;
      return updateUI(chatId, uid, `📝 <b>Text Builder:</b>\n\nআপনার টেক্সট সেন্ড করুন:\n<i>(বাটন দিতে চাইলে শেষে BUTTONS: দিয়ে Name | Link লিখবেন)</i>`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'clear_screen' }]] });
    }
    
    if (cmd === '/media') {
      resetSession(uid, true);
      session.state = STATES.WAIT_MEDIA;
      return updateUI(chatId, uid, `📎 <b>Media Builder:</b>\n\nযেকোনো ছবি, ভিডিও বা অ্যালবাম সেন্ড করুন:`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'clear_screen' }]] });
    }

    if (cmd === '/raw') {
      resetSession(uid, true);
      session.state = STATES.WAIT_RAW;
      return updateUI(chatId, uid, `💻 <b>Raw HTML Mode:</b>\n\nকোড সেন্ড করুন:`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'clear_screen' }]] });
    }

    if (cmd === '/repost') {
      resetSession(uid, true);
      session.state = STATES.WAIT_REPOST;
      return updateUI(chatId, uid, `🔄 <b>Repost Mode:</b>\n\nযে মেসেজটি চ্যানেলে দিতে চান সেটি এখানে Forward করুন:`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'clear_screen' }]] });
    }
    return;
  }

  // 3. Mode Processing Logics
  if (session.state === STATES.WAIT_REPOST || (session.state === STATES.IDLE && msg.forward_date)) {
    try {
      if (bot.copyMessage) await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      else await bot.forwardMessage(CHANNEL_ID, chatId, msg.message_id);
      resetSession(uid, true);
      return updateUI(chatId, uid, `✅ <b>Successfully Reposted!</b>`, { inline_keyboard: [[{ text: '🧹 Clear Screen', callback_data: 'clear_screen' }]] });
    } catch { return updateUI(chatId, uid, `❌ <b>Error Reposting.</b>`, { inline_keyboard: [[{ text: '🧹 Clear Screen', callback_data: 'clear_screen' }]] }); }
  }

  if ([STATES.IDLE, STATES.WAIT_MEDIA].includes(session.state) && (msg.photo || msg.video || msg.document || msg.audio || msg.voice || msg.animation || msg.sticker)) {
    if (msg.media_group_id) {
      const type = msg.photo ? 'photo' : 'video';
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video.file_id;
      if (session.album.id !== msg.media_group_id) { clearTimeout(session.album.timer); session.album = { id: msg.media_group_id, items:[], timer: null }; }
      session.album.items.push({ type, media: fileId });
      
      clearTimeout(session.album.timer);
      session.album.timer = setTimeout(() => {
        session.mediaAlbumItems = session.album.items.slice();
        session.postType = 'album'; session.album.id = null;
        session.state = STATES.WAIT_TEXT;
        updateUI(chatId, uid, `✅ <b>Album (${session.mediaAlbumItems.length}) Received!</b>\n\nক্যাপশন টেক্সট দিন অথবা স্কিপ করুন:`, getStyleMenu(session));
      }, 1200);
      return;
    } else {
      session.mediaId = (msg.photo?.pop() || msg.video || msg.document || msg.audio || msg.voice || msg.animation || msg.sticker).file_id;
      session.postType = msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.audio ? 'audio' : msg.voice ? 'voice' : msg.animation ? 'animation' : 'sticker';
      session.state =['sticker', 'video_note'].includes(session.postType) ? STATES.WAIT_CONFIRM : STATES.WAIT_TEXT;
      if (session.state === STATES.WAIT_CONFIRM) return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
      return updateUI(chatId, uid, `✅ <b>Media Detected!</b>\n\nক্যাপশন টেক্সট সেন্ড করুন অথবা স্কিপ করুন:`, getStyleMenu(session));
    }
  }

  const rawText = msg.text || msg.caption || '';
  if (!rawText.trim()) return;

  const { textOnly, buttons } = parseButtonsBlock(rawText);
  if (buttons.length) session.draftButtons = buttons;

  if (session.state === STATES.WAIT_RAW) {
    session.draftBlocks.push(textOnly);
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }

  if (session.state === STATES.IDLE || session.state === STATES.WAIT_TEXT) {
    session.tempRawText = textOnly;
    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `🎨 <b>Select Style:</b>\n\nটেক্সটটির জন্য স্টাইল নির্বাচন করুন:`, getStyleMenu(session));
  }
});

// ---------------- STARTUP & MENU SETUP ----------------
async function startBot() {
  console.log('Starting Clean UI Bot...');
  await bot.deleteWebHook().catch(() => {});
  
  // Set Bottom-Left Telegram Menu Commands
  await bot.setMyCommands([
    { command: 'start', description: '🏠 Home / Reset' },
    { command: 'text', description: '📝 Create Text / Multi-Block Post' },
    { command: 'media', description: '📎 Send Media / Album' },
    { command: 'raw', description: '💻 Send Raw HTML' },
    { command: 'repost', description: '🔄 Repost Message' },
    { command: 'cancel', description: '❌ Cancel & Clear Screen' }
  ]);
  
  await bot.startPolling();
  console.log('Bot is live with Menu Button and 100% Clean Ghost UI!');
}
startBot();
