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
  .filter(Boolean)
  .map(Number)
  .filter(n => Number.isFinite(n));

if (!BOT_TOKEN || !CHANNEL_ID || OWNER_IDS.length === 0) {
  console.error('Missing Environment Variables! Required: BOT_TOKEN, CHANNEL_ID, OWNER_IDS/OWNER_ID');
  process.exit(1);
}

function isOwner(uid) {
  return OWNER_IDS.includes(uid);
}

// ---------------- EXPRESS (Health) ----------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Channel Manager Pro Bot is Online.');
});

const server = app.listen(PORT, () => {
  console.log(`Health server running on :${PORT}`);
});

server.on('error', (err) => {
  console.error('Express server error:', err?.message || err);
  process.exit(1);
});

// ---------------- BOT ----------------
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: false,
    interval: 300,
    params: {
      timeout: 10,
    },
  },
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err?.message || err);
});

bot.on('webhook_error', (err) => {
  console.error('Webhook error:', err?.message || err);
});

process.on('unhandledRejection', (e) => {
  console.error('UnhandledRejection:', e);
});

process.on('uncaughtException', (e) => {
  console.error('UncaughtException:', e);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Stopping bot...');
  try { await bot.stopPolling(); } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Stopping bot...');
  try { await bot.stopPolling(); } catch (_) {}
  process.exit(0);
});

// ---------------- SESSION ----------------
const STATES = Object.freeze({
  IDLE: 'IDLE',
  WAIT_MEDIA: 'WAIT_MEDIA',
  WAIT_STYLE: 'WAIT_STYLE',
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
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function safeDelete(chatId, msgId) {
  try {
    await bot.deleteMessage(chatId, msgId);
  } catch (_) {}
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
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
      if (parts.length < 2) continue;

      const label = parts[0];
      const url = normalizeUrl(parts[1]);
      if (!label || !url) continue;

      row.push({ text: label.slice(0, 64), url });
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
    case 'normal':       return safe;
    case 'title':        return `🏆 <b>${escapeHtml(text.toUpperCase())}</b>\n━━━━━━━━━━━━━━━━━`;
    case 'bold':         return `<b>${safe}</b>`;
    case 'italic':       return `<i>${safe}</i>`;
    case 'underline':    return `<u>${safe}</u>`;
    case 'strike':       return `<s>${safe}</s>`;
    case 'spoiler':      return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code':         return `<code>${safe}</code>`;
    case 'pre':          return `<pre>${safe}</pre>`;
    case 'quote':        return `<blockquote>${safe}</blockquote>`;
    case 'expand_quote': return `<blockquote>${safe}</blockquote>`; // safe fallback
    case 'heading':      return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets':      return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'numbered':     return lines.map((l, i) => `<b>${i + 1}.</b> ${escapeHtml(l)}`).join('\n');
    case 'pros':         return lines.map(l => `✅ ${escapeHtml(l)}`).join('\n');
    case 'cons':         return lines.map(l => `❌ ${escapeHtml(l)}`).join('\n');
    case 'note':         return `📌 <b>Note:</b> ${safe}`;
    case 'warning':      return `⚠️ <b>Warning:</b> ${safe}`;
    case 'signature':    return `<i>— ${safe}</i>`;
    default:             return safe;
  }
}

// ---------------- MENUS ----------------
const MAIN_MENU = {
  inline_keyboard: [
    [
      { text: '⚡ Quick Text', callback_data: 'mode_quick' },
      { text: '🧱 Multi-Block', callback_data: 'mode_multi' },
    ],
    [{ text: '📎 Media / File / Album', callback_data: 'mode_media' }],
    [
      { text: '📝 Raw HTML', callback_data: 'mode_raw' },
      { text: '😶‍🌫️ Spoiler', callback_data: 'mode_spoiler' },
    ],
    [{ text: '🔄 Repost / Copy Message', callback_data: 'mode_repost' }],
    [{ text: '❌ Reset', callback_data: 'reset' }],
  ],
};

const CANCEL_MENU = {
  inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'cancel' }]],
};

const CONFIRM_MENU = {
  inline_keyboard: [
    [
      { text: '✅ Publish', callback_data: 'confirm_publish' },
      { text: '✏️ Edit', callback_data: 'confirm_edit' },
    ],
    [{ text: '🔙 Cancel', callback_data: 'cancel' }],
  ],
};

const STYLES = [
  { id: 'normal', text: 'Normal 🔤' },      { id: 'title', text: '🏆 Title' },
  { id: 'bold', text: 'Bold' },            { id: 'italic', text: 'Italic' },
  { id: 'underline', text: 'Underline' },  { id: 'strike', text: 'Strike' },
  { id: 'heading', text: '🔹 Heading' },   { id: 'quote', text: '❝ Quote' },
  { id: 'expand_quote', text: '📖 Exp. Quote' }, { id: 'spoiler', text: '🌫️ Spoiler' },
  { id: 'code', text: 'Code (Inline)' },   { id: 'pre', text: 'Code Block' },
  { id: 'bullets', text: '• Bullets' },    { id: 'numbered', text: '1️⃣ Numbered' },
  { id: 'pros', text: '✅ Pros' },         { id: 'cons', text: '❌ Cons' },
  { id: 'note', text: '📌 Note' },         { id: 'warning', text: '⚠️ Warning' },
  { id: 'link', text: '🔗 Text Link' },    { id: 'signature', text: '✍️ Signature' },
];

function getStyleMenu(session) {
  const keyboard = [];

  const hasMedia = Boolean(session.mediaId) || Boolean(session.mediaAlbumItems);
  if (session.mode === 'media' && hasMedia) {
    keyboard.push([{ text: '🚀 Skip Caption (Direct Post)', callback_data: 'action_skip_caption' }]);
  }

  for (let i = 0; i < STYLES.length; i += 2) {
    keyboard.push([
      { text: STYLES[i].text, callback_data: `style_${STYLES[i].id}` },
      ...(STYLES[i + 1] ? [{ text: STYLES[i + 1].text, callback_data: `style_${STYLES[i + 1].id}` }] : []),
    ]);
  }

  if (session.mode === 'multi') {
    if (session.draftBlocks.length > 0) {
      keyboard.push([{ text: `↩️ Undo Last (Now: ${session.draftBlocks.length})`, callback_data: 'action_undo_last' }]);
      keyboard.push([{ text: `🗑️ Clear Draft`, callback_data: 'action_clear_draft' }]);
      keyboard.push([{ text: `🚀 Publish (${session.draftBlocks.length} blocks)`, callback_data: 'action_publish' }]);
    }
  }

  keyboard.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: keyboard };
}

// ---------------- UI ----------------
async function updateUI(chatId, uid, text, markup) {
  const session = getSession(uid);

  const payload = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(markup ? { reply_markup: markup } : {}),
  };

  if (session.lastMenuMsgId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: session.lastMenuMsgId,
        ...payload,
      });
      return;
    } catch (err) {
      const desc = err?.response?.body?.description || '';
      if (desc.includes('not modified') || desc.includes('exactly the same')) return;
      await safeDelete(chatId, session.lastMenuMsgId);
      session.lastMenuMsgId = null;
    }
  }

  const sent = await bot.sendMessage(chatId, text, payload);
  session.lastMenuMsgId = sent.message_id;
}

// ---------------- PUBLISH HELPERS ----------------
async function sendLongTextToChannel(html, replyMarkup) {
  const MAX = 4096;

  if (html.length <= MAX) {
    return bot.sendMessage(CHANNEL_ID, html, {
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      disable_web_page_preview: true,
    });
  }

  const parts = html.split(/\n{2,}/g).filter(Boolean);
  if (parts.length <= 1) {
    throw new Error('Message too long to send safely. Add spacing between blocks or shorten text.');
  }

  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    if (chunk.length > MAX) throw new Error('A block is too long to send.');

    await bot.sendMessage(CHANNEL_ID, chunk, {
      parse_mode: 'HTML',
      ...(i === parts.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
      disable_web_page_preview: true,
    });
  }
}

function mediaCaptionLimit(postType) {
  const noCaption = ['sticker', 'video_note'];
  if (noCaption.includes(postType)) return 0;
  return 1024;
}

async function sendSingleMedia(postType, mediaId, htmlCaption, buttons) {
  const limit = mediaCaptionLimit(postType);
  const hasCaption = Boolean(htmlCaption && htmlCaption.trim());
  const captionTooLong = hasCaption && limit > 0 && htmlCaption.length > limit;

  if (captionTooLong) {
    await sendSingleMedia(postType, mediaId, '', null);
    await sendLongTextToChannel(htmlCaption, buttons);
    return;
  }

  const optsWithCaption = (limit > 0 && hasCaption)
    ? { caption: htmlCaption, parse_mode: 'HTML' }
    : {};

  const opts = {
    ...optsWithCaption,
    ...(buttons ? { reply_markup: buttons } : {}),
    disable_web_page_preview: true,
  };

  switch (postType) {
    case 'photo':      return bot.sendPhoto(CHANNEL_ID, mediaId, opts);
    case 'video':      return bot.sendVideo(CHANNEL_ID, mediaId, opts);
    case 'document':   return bot.sendDocument(CHANNEL_ID, mediaId, opts);
    case 'audio':      return bot.sendAudio(CHANNEL_ID, mediaId, opts);
    case 'voice':      return bot.sendVoice(CHANNEL_ID, mediaId, opts);
    case 'animation':  return bot.sendAnimation(CHANNEL_ID, mediaId, opts);
    case 'sticker':    return bot.sendSticker(CHANNEL_ID, mediaId, { ...(buttons ? { reply_markup: buttons } : {}) });
    case 'video_note': return bot.sendVideoNote(CHANNEL_ID, mediaId, { ...(buttons ? { reply_markup: buttons } : {}) });
    default:
      throw new Error(`Unsupported media type: ${postType}`);
  }
}

async function sendAlbum(items, htmlCaption, buttons) {
  const hasButtons = Boolean(buttons);
  const hasCaption = Boolean(htmlCaption && htmlCaption.trim());

  if (hasButtons) {
    await bot.sendMediaGroup(CHANNEL_ID, items.map(it => ({ type: it.type, media: it.media })));
    await sendLongTextToChannel(hasCaption ? htmlCaption : '🔗', buttons);
    return;
  }

  const CAPTION_MAX = 1024;
  if (hasCaption && htmlCaption.length > CAPTION_MAX) {
    await bot.sendMediaGroup(CHANNEL_ID, items.map(it => ({ type: it.type, media: it.media })));
    await sendLongTextToChannel(htmlCaption, null);
    return;
  }

  const mediaPayload = items.map((it, idx) => {
    if (idx === 0 && hasCaption) {
      return { type: it.type, media: it.media, caption: htmlCaption, parse_mode: 'HTML' };
    }
    return { type: it.type, media: it.media };
  });

  await bot.sendMediaGroup(CHANNEL_ID, mediaPayload);
}

async function publishPending(session) {
  const p = session.pending;
  if (!p) throw new Error('No pending payload.');

  if (p.kind === 'text') {
    await sendLongTextToChannel(p.html, p.buttons);
    return;
  }

  if (p.kind === 'media') {
    await sendSingleMedia(p.postType, p.mediaId, p.html || '', p.buttons);
    return;
  }

  if (p.kind === 'album') {
    await sendAlbum(p.items, p.html || '', p.buttons);
    return;
  }

  throw new Error('Unknown pending kind.');
}

function renderPendingPreview(session) {
  const p = session.pending;
  if (!p) return 'No preview available.';

  if (p.kind === 'album') {
    const btnHint = p.buttons ? `Buttons: ✅ (will be sent as separate message)` : `Buttons: ❌`;
    const capHint = p.html?.trim() ? 'Caption: ✅' : 'Caption: ❌';
    return `🧾 <b>Preview (Album)</b>\n\nItems: <b>${p.items.length}</b>\n${capHint}\n${btnHint}`;
  }

  if (p.previewHtmlMode) {
    const btnHint = p.buttons ? `\n\n<i>Buttons:</i> ✅` : `\n\n<i>Buttons:</i> ❌`;
    return `🧾 <b>Preview</b>\n\n${p.html}${btnHint}`;
  }

  return `🧾 <b>Preview (Raw)</b>\n\n<pre>${escapeHtml(p.rawHtml || '')}</pre>`;
}

// ---------------- MEDIA ----------------
function extractSingleMedia(msg) {
  if (msg.photo) {
    const file_id = msg.photo[msg.photo.length - 1].file_id;
    return { postType: 'photo', mediaId: file_id };
  }
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
  if (msg.photo) {
    const file_id = msg.photo[msg.photo.length - 1].file_id;
    return { type: 'photo', media: file_id };
  }
  if (msg.video) {
    return { type: 'video', media: msg.video.file_id };
  }
  return null;
}

function scheduleFinalizeAlbum(uid) {
  const session = getSession(uid);
  const chatId = session.chatId;
  if (!chatId) return;

  clearAlbumTimer(session);

  session.album.timer = setTimeout(async () => {
    try {
      const items = session.album.items.slice();
      const count = items.length;

      session.mediaAlbumItems = items;
      session.postType = 'album';
      session.mediaId = null;

      session.album.id = null;
      session.album.items = [];
      session.album.timer = null;

      session.state = STATES.WAIT_STYLE;
      await updateUI(
        chatId,
        uid,
        `✅ <b>Album received!</b>\n\nItems: <b>${count}</b>\nএখন caption এর স্টাইল সিলেক্ট করুন, অথবা Skip Caption দিন:`,
        getStyleMenu(session)
      );
    } catch (e) {
      console.error('Album finalize error:', e);
    }
  }, 1200);
}

// ---------------- COMMANDS ----------------
async function openMainMenu(chatId, uid, reset = true) {
  const session = getSession(uid);
  session.chatId = chatId;

  if (reset) resetSession(uid, true);
  getSession(uid).chatId = chatId;

  await updateUI(
    chatId,
    uid,
    `👑 <b>Channel Manager Pro (All-in-One)</b>\n\nমেনু থেকে একটি অপশন নির্বাচন করুন:`,
    MAIN_MENU
  );
}

bot.onText(/^\/start$/i, async (msg) => {
  const uid = msg.from?.id;
  if (!isOwner(uid)) return;
  if (msg.chat.type !== 'private') return;

  if (GHOST_MODE) await safeDelete(msg.chat.id, msg.message_id);
  await openMainMenu(msg.chat.id, uid, true);
});

bot.onText(/^\/menu$/i, async (msg) => {
  const uid = msg.from?.id;
  if (!isOwner(uid)) return;
  if (msg.chat.type !== 'private') return;

  if (GHOST_MODE) await safeDelete(msg.chat.id, msg.message_id);
  await openMainMenu(msg.chat.id, uid, false);
});

bot.onText(/^\/cancel$/i, async (msg) => {
  const uid = msg.from?.id;
  if (!isOwner(uid)) return;
  if (msg.chat.type !== 'private') return;

  if (GHOST_MODE) await safeDelete(msg.chat.id, msg.message_id);
  resetSession(uid, true);
  await updateUI(msg.chat.id, uid, `✅ Cancel করা হয়েছে।`, MAIN_MENU);
});

bot.onText(/^\/ping$/i, async (msg) => {
  const uid = msg.from?.id;
  if (!isOwner(uid)) return;
  if (msg.chat.type !== 'private') return;

  try {
    await bot.sendMessage(msg.chat.id, '✅ Bot is alive.');
  } catch (e) {
    console.error('Ping error:', e?.message || e);
  }
});

// ---------------- CALLBACK QUERIES ----------------
bot.on('callback_query', async (query) => {
  const uid = query.from?.id;
  if (!isOwner(uid)) {
    return bot.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true });
  }

  const msg = query.message;
  if (!msg || msg.chat.type !== 'private') {
    return bot.answerCallbackQuery(query.id, { text: 'Use in private chat', show_alert: true });
  }

  const chatId = msg.chat.id;
  const data = query.data;
  const session = getSession(uid);
  session.chatId = chatId;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'cancel' || data === 'reset') {
    resetSession(uid, true);
    await updateUI(chatId, uid, `🏠 <b>Main Menu</b>\n\nঅপারেশন বাতিল করা হয়েছে।`, MAIN_MENU);
    return;
  }

  if (data === 'confirm_publish') {
    try {
      await publishPending(session);
      resetSession(uid, true);
      await updateUI(chatId, uid, `✅ <b>Published to channel successfully!</b>`, MAIN_MENU);
    } catch (e) {
      await updateUI(chatId, uid, `❌ <b>Publish failed:</b> ${escapeHtml(e.message || 'Unknown error')}`, CANCEL_MENU);
    }
    return;
  }

  if (data === 'confirm_edit') {
    if (!session.mode) {
      await openMainMenu(chatId, uid, true);
      return;
    }

    if (session.mode === 'raw') {
      session.state = STATES.WAIT_RAW;
      session.pending = null;
      await updateUI(chatId, uid, `📝 <b>Raw HTML</b>\n\nআবার HTML পাঠান:`, CANCEL_MENU);
      return;
    }

    if (session.mode === 'spoiler') {
      session.state = STATES.WAIT_SPOILER;
      session.pending = null;
      await updateUI(chatId, uid, `😶‍🌫️ <b>Spoiler</b>\n\nআবার টেক্সট পাঠান:`, CANCEL_MENU);
      return;
    }

    if (session.mode === 'multi') {
      session.state = STATES.WAIT_STYLE;
      session.pending = null;
      await updateUI(chatId, uid, `🧱 <b>Multi-Block</b>\n\nস্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
      return;
    }

    session.state = STATES.WAIT_STYLE;
    session.pending = null;
    await updateUI(chatId, uid, `🎨 স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }

  if (data.startsWith('mode_')) {
    const selectedMode = data.replace('mode_', '');
    resetSession(uid, true);

    const s = getSession(uid);
    s.chatId = chatId;
    s.mode = selectedMode;

    if (selectedMode === 'quick') {
      s.state = STATES.WAIT_STYLE;
      s.postType = 'text';
      await updateUI(chatId, uid, `⚡ <b>Quick Text</b>\n\nটেক্সটের স্টাইল সিলেক্ট করুন:`, getStyleMenu(s));
      return;
    }

    if (selectedMode === 'multi') {
      s.state = STATES.WAIT_STYLE;
      s.postType = 'text';
      await updateUI(chatId, uid, `🧱 <b>Multi-Block Mode</b>\n\nপ্রথম ব্লকের স্টাইল সিলেক্ট করুন:`, getStyleMenu(s));
      return;
    }

    if (selectedMode === 'media') {
      s.state = STATES.WAIT_MEDIA;
      await updateUI(
        chatId,
        uid,
        `📎 <b>Media/File/Album Mode</b>\n\nযেকোনো মিডিয়া পাঠান:\n• Photo/Video (single)\n• Photo/Video Album\n• Document (PDF/ZIP)\n• Audio/Voice\n• GIF (Animation)\n• Sticker / Video Note\n\nতারপর caption চাইলে স্টাইল সিলেক্ট করবেন।`,
        CANCEL_MENU
      );
      return;
    }

    if (selectedMode === 'raw') {
      s.state = STATES.WAIT_RAW;
      await updateUI(chatId, uid, `📝 <b>Raw HTML Mode</b>\n\nHTML পাঠান। Buttons দিতে চাইলে:\n<pre>BUTTONS:\nName | https://url</pre>`, CANCEL_MENU);
      return;
    }

    if (selectedMode === 'spoiler') {
      s.state = STATES.WAIT_SPOILER;
      await updateUI(chatId, uid, `😶‍🌫️ <b>Spoiler Mode</b>\n\nটেক্সট পাঠান:`, CANCEL_MENU);
      return;
    }

    if (selectedMode === 'repost') {
      s.state = STATES.WAIT_REPOST;
      await updateUI(chatId, uid, `🔄 <b>Repost Mode</b>\n\nযে মেসেজ কপি করতে চান সেটি forward/send করুন:`, CANCEL_MENU);
      return;
    }

    await openMainMenu(chatId, uid, true);
    return;
  }

  if (data.startsWith('style_')) {
    session.selectedStyle = data.replace('style_', '');
    session.state = STATES.WAIT_TEXT;

    const styleName = STYLES.find(s => s.id === session.selectedStyle)?.text || session.selectedStyle;

    let instructions = `✏️ <b>Editor (${escapeHtml(styleName)})</b>\n\nটেক্সট লিখে পাঠান।`;
    if (session.selectedStyle === 'link') {
      instructions += `\n\n<blockquote><b>ফরম্যাট:</b>\n<code>Text | https://example.com</code></blockquote>`;
    } else {
      instructions += `\n\n<blockquote><b>Buttons (optional):</b>\n<pre>BUTTONS:\nGoogle | https://google.com\nA | https://a.com || B | https://b.com</pre></blockquote>`;
    }

    await updateUI(chatId, uid, instructions, CANCEL_MENU);
    return;
  }

  if (data === 'action_undo_last') {
    if (session.draftBlocks.length > 0) session.draftBlocks.pop();
    if (session.draftBlocks.length === 0) session.draftButtons = [];
    await updateUI(chatId, uid, `↩️ <b>Undo done.</b>\n\nস্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }

  if (data === 'action_clear_draft') {
    session.draftBlocks = [];
    session.draftButtons = [];
    await updateUI(chatId, uid, `🗑️ <b>Draft Cleared.</b>\n\nস্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }

  if (data === 'action_publish') {
    if (session.draftBlocks.length === 0) return;

    const finalHtml = session.draftBlocks.join('\n\n');
    const buttons = session.draftButtons?.length ? { inline_keyboard: session.draftButtons } : null;

    session.pending = { kind: 'text', html: finalHtml, buttons, previewHtmlMode: true };
    session.state = STATES.WAIT_CONFIRM;

    await updateUI(chatId, uid, renderPendingPreview(session), CONFIRM_MENU);
    return;
  }

  if (data === 'action_skip_caption') {
    if (session.postType === 'album' && session.mediaAlbumItems?.length) {
      session.pending = {
        kind: 'album',
        items: session.mediaAlbumItems,
        html: '',
        buttons: null,
        previewHtmlMode: true,
      };
      session.state = STATES.WAIT_CONFIRM;
      await updateUI(chatId, uid, renderPendingPreview(session), CONFIRM_MENU);
      return;
    }

    if (!session.mediaId || session.postType === 'text') {
      await updateUI(chatId, uid, `⚠️ আগে media পাঠাতে হবে।`, CANCEL_MENU);
      return;
    }

    session.pending = {
      kind: 'media',
      postType: session.postType,
      mediaId: session.mediaId,
      html: '',
      buttons: null,
      previewHtmlMode: true,
    };
    session.state = STATES.WAIT_CONFIRM;
    await updateUI(chatId, uid, `🧾 <b>Preview</b>\n\nMedia will be posted <b>without caption</b>.`, CONFIRM_MENU);
    return;
  }
});

// ---------------- MESSAGE HANDLER ----------------
bot.on('message', async (msg) => {
  const uid = msg.from?.id;
  if (!isOwner(uid)) return;
  if (msg.from?.is_bot) return;
  if (msg.chat.type !== 'private') return;

  if (msg.text && /^\/(start|menu|cancel|ping)/i.test(msg.text)) return;

  const chatId = msg.chat.id;
  const session = getSession(uid);
  session.chatId = chatId;

  if (session.state === STATES.IDLE) {
    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
    return;
  }

  if (session.state === STATES.WAIT_REPOST) {
    try {
      if (typeof bot.copyMessage === 'function') {
        await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      } else {
        await bot.forwardMessage(CHANNEL_ID, chatId, msg.message_id);
      }

      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

      resetSession(uid, true);
      await updateUI(chatId, uid, `✅ <b>Copied to channel!</b>`, MAIN_MENU);
    } catch (e) {
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      await updateUI(chatId, uid, `❌ <b>Copy failed:</b> protected content / permission issue / invalid message.`, CANCEL_MENU);
    }
    return;
  }

  if (session.state === STATES.WAIT_MEDIA) {
    const groupId = msg.media_group_id;
    if (groupId) {
      const item = extractAlbumItem(msg);
      if (!item) {
        if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
        await updateUI(chatId, uid, `⚠️ Album হিসেবে শুধু Photo/Video সাপোর্টেড।`, CANCEL_MENU);
        return;
      }

      if (session.album.id !== groupId) {
        clearAlbumTimer(session);
        session.album.id = groupId;
        session.album.items = [];
      }

      session.album.items.push(item);

      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

      scheduleFinalizeAlbum(uid);
      return;
    }

    const media = extractSingleMedia(msg);
    if (!media) {
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      await updateUI(chatId, uid, `⚠️ <b>ভুল ইনপুট</b>\nMedia/File পাঠান (photo/video/document/audio/voice/gif/sticker/video note)।`, CANCEL_MENU);
      return;
    }

    session.mediaId = media.mediaId;
    session.postType = media.postType;
    session.mediaAlbumItems = null;

    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

    if (['sticker', 'video_note'].includes(session.postType)) {
      session.pending = {
        kind: 'media',
        postType: session.postType,
        mediaId: session.mediaId,
        html: '',
        buttons: null,
        previewHtmlMode: true,
      };
      session.state = STATES.WAIT_CONFIRM;
      await updateUI(chatId, uid, `🧾 <b>Preview</b>\n\nThis media type has no caption.`, CONFIRM_MENU);
      return;
    }

    session.state = STATES.WAIT_STYLE;
    await updateUI(
      chatId,
      uid,
      `✅ <b>Media received!</b>\n\nএখন caption এর স্টাইল সিলেক্ট করুন, অথবা Skip Caption দিন:`,
      getStyleMenu(session)
    );
    return;
  }

  if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

  const rawText = msg.text || msg.caption || '';
  if (!rawText.trim()) {
    await updateUI(chatId, uid, `⚠️ <b>টেক্সট পাওয়া যায়নি</b>\nটেক্সট লিখে পাঠান।`, CANCEL_MENU);
    return;
  }

  const { textOnly, buttons } = parseButtonsBlock(rawText);
  const plainText = textOnly.trim();
  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : null;

  if (session.state === STATES.WAIT_RAW || session.state === STATES.WAIT_SPOILER) {
    let finalHtml;
    if (session.state === STATES.WAIT_SPOILER) finalHtml = `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`;
    else finalHtml = plainText;

    session.pending = {
      kind: 'text',
      html: finalHtml,
      rawHtml: plainText,
      buttons: replyMarkup,
      previewHtmlMode: session.state !== STATES.WAIT_RAW,
    };
    session.state = STATES.WAIT_CONFIRM;

    await updateUI(chatId, uid, renderPendingPreview(session), CONFIRM_MENU);
    return;
  }

  if (session.state === STATES.WAIT_TEXT) {
    if (!plainText) {
      await updateUI(chatId, uid, `⚠️ <b>Empty text</b>`, CANCEL_MENU);
      return;
    }

    let htmlBlock;
    if (session.selectedStyle === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (parts.length < 2) {
        await updateUI(chatId, uid, `⚠️ <b>Link format ভুল</b>\n<code>Text | https://example.com</code>`, CANCEL_MENU);
        return;
      }

      const label = parts[0];
      const url = normalizeUrl(parts[1]);
      if (!url) {
        await updateUI(chatId, uid, `⚠️ <b>Invalid URL</b>`, CANCEL_MENU);
        return;
      }

      htmlBlock = `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    } else {
      htmlBlock = buildStyledHtml(session.selectedStyle, plainText);
    }

    if (session.mode === 'multi') {
      session.draftBlocks.push(htmlBlock);
      if (buttons.length) session.draftButtons = buttons;

      session.state = STATES.WAIT_STYLE;
      await updateUI(
        chatId,
        uid,
        `🧱 <b>Block added!</b>\n\nবর্তমানে: <b>${session.draftBlocks.length}</b> blocks.\nপরবর্তী স্টাইল সিলেক্ট করুন অথবা Publish করুন:`,
        getStyleMenu(session)
      );
      return;
    }

    if (session.mode === 'quick' && session.postType === 'text') {
      session.pending = { kind: 'text', html: htmlBlock, buttons: replyMarkup, previewHtmlMode: true };
      session.state = STATES.WAIT_CONFIRM;
      await updateUI(chatId, uid, renderPendingPreview(session), CONFIRM_MENU);
      return;
    }

    if (session.mode === 'media') {
      if (session.postType === 'album' && session.mediaAlbumItems?.length) {
        session.pending = {
          kind: 'album',
          items: session.mediaAlbumItems,
          html: htmlBlock,
          buttons: replyMarkup,
          previewHtmlMode: true,
        };
        session.state = STATES.WAIT_CONFIRM;
        await updateUI(chatId, uid, renderPendingPreview(session), CONFIRM_MENU);
        return;
      }

      if (!session.mediaId || session.postType === 'text') {
        await updateUI(chatId, uid, `⚠️ আগে media পাঠাতে হবে।`, CANCEL_MENU);
        return;
      }

      session.pending = {
        kind: 'media',
        postType: session.postType,
        mediaId: session.mediaId,
        html: htmlBlock,
        buttons: replyMarkup,
        previewHtmlMode: true,
      };
      session.state = STATES.WAIT_CONFIRM;

      await updateUI(chatId, uid, `🧾 <b>Preview</b>\n\nCaption preview:\n\n${htmlBlock}`, CONFIRM_MENU);
      return;
    }

    await updateUI(chatId, uid, `⚠️ Unknown flow. Reset করুন।`, MAIN_MENU);
  }
});

// ---------------- STARTUP ----------------
async function startBot() {
  try {
    console.log('Starting bot...');

    // remove webhook if any
    try {
      await bot.deleteWebHook();
      console.log('Webhook cleared.');
    } catch (e) {
      console.error('deleteWebHook failed:', e?.message || e);
    }

    await bot.startPolling();
    console.log('Polling started.');

    try {
      await bot.setMyCommands([
        { command: 'start', description: 'Open Main Menu / Restart' },
        { command: 'menu', description: 'Open Main Menu' },
        { command: 'cancel', description: 'Cancel current operation' },
        { command: 'ping', description: 'Check bot status' },
      ]);
      console.log('Bot commands set.');
    } catch (e) {
      console.error('setMyCommands failed:', e?.message || e);
    }

    const me = await bot.getMe();
    console.log(`Bot started successfully as @${me.username}`);
  } catch (e) {
    console.error('Fatal startup error:', e?.message || e);
    process.exit(1);
  }
}

startBot();
