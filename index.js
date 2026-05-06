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
  WAIT_MEDIA: 'WAIT_MEDIA',
  WAIT_STYLE: 'WAIT_STYLE',
  WAIT_STYLE_PREVIEW: 'WAIT_STYLE_PREVIEW',
  WAIT_TEXT: 'WAIT_TEXT',
  WAIT_RAW: 'WAIT_RAW',
  WAIT_CONFIRM: 'WAIT_CONFIRM',
});

const sessions = Object.create(null);

function defaultSession() {
  return {
    chatId: null,
    state: STATES.IDLE,
    mode: null,
    selectedStyle: 'normal',
    stylePage: 0, // NEW: For Style Pagination
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

// ---------------- UTILITIES & ANIMATIONS ----------------
function escapeHtml(text) {
  if (text === undefined || text === null) return '';
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

// ---------------- HTML BUILDER (ALL 24 STYLES) ----------------
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
    case 'expand_quote': return `<blockquote expandable>${safe}</blockquote>`;
    case 'heading':      return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets':      return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'numbered':     return lines.map((l, i) => `<b>${i + 1}.</b> ${escapeHtml(l)}`).join('\n');
    case 'pros':         return lines.map(l => `✅ ${escapeHtml(l)}`).join('\n');
    case 'cons':         return lines.map(l => `❌ ${escapeHtml(l)}`).join('\n');
    case 'note':         return `📌 <b>Note:</b> ${safe}`;
    case 'warning':      return `⚠️ <b>Warning:</b> ${safe}`;
    case 'signature':    return `<i>— ${safe}</i>`;
    case 'center':       return `──────────────\n<b>${safe}</b>\n──────────────`;
    case 'divider':      return `━━━━━━━━━━━━━━━━━━`;
    case 'highlight':    return `✨ <b>${safe}</b> ✨`;
    case 'mono_quote':   return `<blockquote><code>${safe}</code></blockquote>`;
    default:             return safe;
  }
}

function buildStylePreview(style) {
  const demoTextMap = {
    normal: 'Normal style example', title: 'Title style example',
    bold: 'Bold style example', italic: 'Italic style example',
    underline: 'Underline style example', strike: 'Strike style example',
    heading: 'Heading style example', quote: 'Quote style example',
    expand_quote: 'Expand Quote style example', spoiler: 'Spoiler style example',
    code: 'Inline Code Example', pre: 'Code Block Example',
    bullets: 'Point 1\nPoint 2\nPoint 3', numbered: 'Step 1\nStep 2\nStep 3',
    pros: 'Fast\nClean', cons: 'Limit 1\nLimit 2',
    note: 'Important Note', warning: 'Warning Message',
    signature: 'Yasin', center: 'Centered Style', divider: '', highlight: 'Highlight style example', mono_quote: 'Monospace quoted', link: 'Google | https://google.com',
  };
  if (style === 'link') return `<a href="https://google.com">Google</a>`;
  return buildStyledHtml(style, demoTextMap[style] ?? 'Sample Preview');
}

// ---------------- MENUS (SMART & CLEAN) ----------------
const MAIN_MENU = {
  inline_keyboard: [[{ text: '🧱 Create Multi-Block', callback_data: 'mode_multi' }, { text: '📝 Raw HTML', callback_data: 'mode_raw' }],
    [{ text: '❌ Reset Bot', callback_data: 'reset' }],
  ],
};

const CANCEL_MENU = { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'cancel' }]] };

const STYLES =[
  // Page 1 (Basic & Most Used)
  { id: 'normal', text: 'Normal 🔤' }, { id: 'title', text: '🏆 Title' },
  { id: 'bold', text: 'Bold' }, { id: 'italic', text: 'Italic' },
  { id: 'heading', text: '🔹 Heading' }, { id: 'spoiler', text: '🌫️ Spoiler' },
  { id: 'quote', text: '❝ Quote' }, { id: 'link', text: '🔗 Text Link' },
  // Page 2 (Lists & Code)
  { id: 'bullets', text: '• Bullets' }, { id: 'numbered', text: '1️⃣ Numbered' },
  { id: 'pros', text: '✅ Pros' }, { id: 'cons', text: '❌ Cons' },
  { id: 'code', text: 'Code (Inline)' }, { id: 'pre', text: 'Code Block' },
  { id: 'expand_quote', text: '📖 Exp. Quote' }, { id: 'mono_quote', text: '🧾 Mono Quote' },
  // Page 3 (Highlights & Extras)
  { id: 'note', text: '📌 Note' }, { id: 'warning', text: '⚠️ Warning' },
  { id: 'highlight', text: '✨ Highlight' }, { id: 'center', text: '🎯 Center' },
  { id: 'strike', text: 'Strike' }, { id: 'underline', text: 'Underline' },
  { id: 'divider', text: '➖ Divider' }, { id: 'signature', text: '✍️ Signature' },
];

function getStyleMenu(session) {
  const itemsPerPage = 8;
  const totalPages = Math.ceil(STYLES.length / itemsPerPage);
  
  if (session.stylePage < 0) session.stylePage = totalPages - 1;
  if (session.stylePage >= totalPages) session.stylePage = 0;

  const start = session.stylePage * itemsPerPage;
  const pageStyles = STYLES.slice(start, start + itemsPerPage);

  const keyboard =[];
  
  if (session.mode === 'media' && (session.mediaId || session.mediaAlbumItems)) {
    keyboard.push([{ text: '🚀 Skip Caption (Direct Post)', callback_data: 'action_skip_caption' }]);
  }

  for (let i = 0; i < pageStyles.length; i += 2) {
    const row = [{ text: pageStyles[i].text, callback_data: `style_${pageStyles[i].id}` }];
    if (pageStyles[i + 1]) row.push({ text: pageStyles[i + 1].text, callback_data: `style_${pageStyles[i + 1].id}` });
    keyboard.push(row);
  }

  // Pagination Buttons
  keyboard.push([
    { text: '⬅️ Prev', callback_data: 'page_prev' },
    { text: `📄 Page ${session.stylePage + 1}/${totalPages}`, callback_data: 'noop' },
    { text: 'Next ➡️', callback_data: 'page_next' }
  ]);

  if (session.mode === 'multi' && session.draftBlocks.length > 0) {
    keyboard.push([{ text: `↩️ Undo Last`, callback_data: 'action_undo_last' }, { text: '🗑️ Clear', callback_data: 'action_clear_draft' }]);
    keyboard.push([{ text: `🚀 Publish (${session.draftBlocks.length} blocks)`, callback_data: 'action_publish' }]);
  }
  
  keyboard.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: keyboard };
}

function getStylePreviewMenu() {
  return {
    inline_keyboard: [[{ text: '✅ Use This Style', callback_data: 'action_use_previewed_style' }],[{ text: '🔙 Back to Styles', callback_data: 'action_back_to_styles' }],
      [{ text: '❌ Cancel', callback_data: 'cancel' }],
    ],
  };
}

function getEditorMenu(styleId) {
  const rows =[];
  if (styleId !== 'link') rows.push([{ text: '🔘 Button Guide', callback_data: 'action_show_button_guide' }]);
  rows.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: rows };
}

function getConfirmMenu(session) {
  const kb = [[{ text: '✅ Publish Now', callback_data: 'confirm_publish' }],[
      { text: '🔕 Silent', callback_data: 'confirm_publish_silent' },
      { text: '📌 Pin', callback_data: 'confirm_publish_pin' },
      { text: '🔇 Silent + Pin', callback_data: 'confirm_publish_silent_pin' }
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

function getButtonGuideText() {
  return `🔘 <b>Button Guide</b>\n\nপোস্টের টেক্সটের নিচে বাটন দিতে চাইলে মেসেজের শেষে এইভাবে লিখবেন:\n\n<pre>BUTTONS:\nGoogle | https://google.com\nA | https://a.com || B | https://b.com</pre>`;
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

// ---------------- PUBLISH HELPERS ----------------
async function executePublish(session, opts) {
  const p = session.pending;
  const sendOpts = {
    parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: opts.silent || false,
    ...(p.buttons ? { reply_markup: p.buttons } : {})
  };

  let sentMsg;

  if (p.kind === 'text') {
    const MAX = 4096;
    if (p.html.length <= MAX) {
      sentMsg = await bot.sendMessage(CHANNEL_ID, p.html, sendOpts);
    } else {
      const parts = p.html.split(/\n{2,}/g).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const chunk = parts[i];
        sentMsg = await bot.sendMessage(CHANNEL_ID, chunk, { ...sendOpts, ...(i !== parts.length - 1 ? { reply_markup: undefined } : {}) });
      }
    }
  } else if (p.kind === 'media') {
    if (p.html && !['sticker', 'video_note'].includes(p.postType)) {
      if (p.html.length > 1024) {
        await bot.sendMessage(CHANNEL_ID, p.html, sendOpts);
        sendOpts.caption = '';
      } else {
        sendOpts.caption = p.html;
      }
    }
    
    if (p.postType === 'photo') sentMsg = await bot.sendPhoto(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'video') sentMsg = await bot.sendVideo(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'document') sentMsg = await bot.sendDocument(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'audio') sentMsg = await bot.sendAudio(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'voice') sentMsg = await bot.sendVoice(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'animation') sentMsg = await bot.sendAnimation(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'sticker') sentMsg = await bot.sendSticker(CHANNEL_ID, p.mediaId, sendOpts);
    else if (p.postType === 'video_note') sentMsg = await bot.sendVideoNote(CHANNEL_ID, p.mediaId, sendOpts);
  } else if (p.kind === 'album') {
    const hasCaption = Boolean(p.html);
    const mediaPayload = p.items.map((it, idx) => ({
      type: it.type, media: it.media, ...(idx === 0 && hasCaption && !p.buttons && p.html.length <= 1024 ? { caption: p.html, parse_mode: 'HTML' } : {})
    }));
    
    const msgs = await bot.sendMediaGroup(CHANNEL_ID, mediaPayload, { disable_notification: opts.silent });
    sentMsg = msgs[0];
    if (p.buttons || (hasCaption && p.html.length > 1024)) {
      await bot.sendMessage(CHANNEL_ID, hasCaption ? p.html : '🔗 Links:', sendOpts);
    }
  }

  if (opts.pin && sentMsg) await bot.pinChatMessage(CHANNEL_ID, sentMsg.message_id, { disable_notification: opts.silent });
}

function renderPendingPreview(session) {
  const p = session.pending;
  if (!p) return 'No preview available.';
  if (p.kind === 'album') return `🧾 <b>Preview (Album)</b>\n\nItems: <b>${p.items.length}</b>\nCaption: ${p.html?.trim() ? '✅' : '❌'}\nButtons: ${p.buttons ? '✅' : '❌'}`;
  if (p.previewHtmlMode) return `🧾 <b>Preview</b>\n\n${p.html}${p.buttons ? `\n\n<i>Buttons:</i> ✅` : ''}`;
  return `🧾 <b>Preview (Raw)</b>\n\n<pre>${escapeHtml(p.rawHtml || '')}</pre>`;
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
      const count = session.mediaAlbumItems.length;
      
      session.album.id = null; session.album.items =[]; session.album.timer = null;
      session.state = STATES.WAIT_STYLE;
      await updateUI(session.chatId, uid, `✅ <b>Album received!</b>\n\nItems: <b>${count}</b>\nএখন caption style নির্বাচন করুন:`, getStyleMenu(session));
    } catch (e) { console.error('Album timeout error:', e); }
  }, 1200);
}

// ---------------- MAIN HANDLERS ----------------
bot.onText(/^\/(start|menu|cancel|ping)$/i, async (msg, match) => {
  const uid = String(msg.from?.id);
  const chatId = msg.chat.id;
  const cmd = match[1].toLowerCase();
  if (!isOwner(uid) || msg.chat.type !== 'private') return;

  if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

  if (cmd === 'ping') return bot.sendMessage(chatId, '✅ Bot is alive and running perfectly.');
  if (cmd === 'cancel') {
    resetSession(uid, true);
    return updateUI(chatId, uid, `✅ Cancel করা হয়েছে।`, MAIN_MENU);
  }
  
  resetSession(uid, cmd !== 'start');
  getSession(uid).chatId = chatId;
  
  const welcomeText = `👑 <b>Channel Manager Pro</b>\n\n👇 <b>কোনো মোড সিলেক্ট করার দরকার নেই! জাস্ট:</b>\n• সরাসরি Text সেন্ড করুন।\n• ছবি বা ভিডিও সেন্ড করুন।\n• Repost করতে চাইলে যেকোনো মেসেজ Forward করুন।\n\n<i>অথবা নিচের Advanced Mode ব্যবহার করুন:</i>`;
  await updateUI(chatId, uid, welcomeText, MAIN_MENU);
});

bot.on('callback_query', async (query) => {
  const uid = String(query.from?.id);
  const chatId = query.message.chat.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true });
  
  bot.answerCallbackQuery(query.id).catch(() => {});
  const data = query.data;
  const session = getSession(uid);
  session.chatId = chatId;

  if (data === 'noop') return; // For Pagination page number indicator
  if (data === 'cancel' || data === 'reset') {
    resetSession(uid, true);
    return updateUI(chatId, uid, `🏠 <b>Main Menu</b>\n\nঅপারেশন বাতিল করা হয়েছে।`, MAIN_MENU);
  }

  // Pagination Logic
  if (data === 'page_prev') { session.stylePage--; return updateUI(chatId, uid, `🎨 <b>Choose a style:</b>`, getStyleMenu(session)); }
  if (data === 'page_next') { session.stylePage++; return updateUI(chatId, uid, `🎨 <b>Choose a style:</b>`, getStyleMenu(session)); }

  // Publish Logic
  if (data.startsWith('confirm_publish')) {
    try {
      const isSilent = data.includes('silent');
      const isPin = data.includes('pin');
      
      const animMsgId = await playPublishAnimation(chatId);
      await executePublish(session, { silent: isSilent, pin: isPin });
      await safeDelete(chatId, animMsgId);
      
      resetSession(uid, true);
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
    if (!session.mode) return updateUI(chatId, uid, `🏠 <b>Main Menu</b>`, MAIN_MENU);
    if (session.mode === 'raw') { session.state = STATES.WAIT_RAW; return updateUI(chatId, uid, `📝 <b>Raw HTML</b>\n\nআবার HTML পাঠান:`, CANCEL_MENU); }
    
    session.state = session.mode === 'multi' ? STATES.WAIT_STYLE : STATES.WAIT_TEXT;
    return updateUI(chatId, uid, session.mode === 'multi' ? `🧱 <b>Multi-Block</b>\n\nস্টাইল সিলেক্ট করুন:` : `✏️ <b>Edit Text:</b>\n\nনতুন করে লিখে পাঠান।`, session.mode === 'multi' ? getStyleMenu(session) : CANCEL_MENU);
  }

  // Advanced Modes from Menu
  if (data.startsWith('mode_')) {
    const selectedMode = data.replace('mode_', '');
    resetSession(uid, true);
    const s = getSession(uid);
    s.chatId = chatId; s.mode = selectedMode;

    if (selectedMode === 'multi') {
      s.state = STATES.WAIT_STYLE; s.postType = 'text';
      return updateUI(chatId, uid, `🧱 <b>Multi-Block Mode</b>\n\nস্টাইল নির্বাচন করুন:`, getStyleMenu(s));
    }
    if (selectedMode === 'raw') { s.state = STATES.WAIT_RAW; return updateUI(chatId, uid, `📝 <b>Raw HTML Mode</b>\n\nHTML পাঠান।`, CANCEL_MENU); }
  }

  // Style Selection
  if (data.startsWith('style_')) {
    session.previewStyle = data.replace('style_', '');
    session.state = STATES.WAIT_STYLE_PREVIEW;
    return updateUI(chatId, uid, `👀 <b>Style Preview:</b>\n\n${buildStylePreview(session.previewStyle)}\n\n<i>এই স্টাইলটি ব্যবহার করবেন?</i>`, getStylePreviewMenu());
  }

  if (data === 'action_use_previewed_style') {
    session.selectedStyle = session.previewStyle;
    session.previewStyle = null;

    if (session.pending && session.pending.rawHtml && session.mode === 'quick') {
      session.pending.html = session.selectedStyle === 'link' ? `<a href="${normalizeUrl(session.pending.rawHtml.split('|')[1])}">${escapeHtml(session.pending.rawHtml.split('|')[0])}</a>` : buildStyledHtml(session.selectedStyle, session.pending.rawHtml);
      session.state = STATES.WAIT_CONFIRM;
      return updateUI(chatId, uid, `✨ <b>Style Applied!</b>\n\n${renderPendingPreview(session)}`, getConfirmMenu(session));
    }
    
    session.state = STATES.WAIT_TEXT;
    return updateUI(chatId, uid, session.selectedStyle === 'link' ? `✏️ <b>Editor (Link)</b>\n\nফরম্যাট: \`Text | https://example.com\`` : `✏️ <b>Editor</b>\n\nএখন টেক্সট লিখে পাঠান।`, getEditorMenu(session.selectedStyle));
  }

  if (data === 'action_back_to_styles') { session.state = STATES.WAIT_STYLE; return updateUI(chatId, uid, `🎨 <b>Choose a style:</b>`, getStyleMenu(session)); }
  if (data === 'action_show_button_guide') return updateUI(chatId, uid, getButtonGuideText(), getEditorMenu(session.selectedStyle));
  
  if (data === 'action_undo_last') {
    if (session.draftBlocks.length > 0) session.draftBlocks.pop();
    if (session.draftBlocks.length === 0) session.draftButtons =[];
    return updateUI(chatId, uid, `↩️ <b>Undo done.</b>\n\nস্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
  }
  if (data === 'action_clear_draft') {
    session.draftBlocks = []; session.draftButtons =[];
    return updateUI(chatId, uid, `🗑️ <b>Draft Cleared.</b>\n\nস্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
  }
  if (data === 'action_publish') {
    if (session.draftBlocks.length === 0) return;
    session.pending = { kind: 'text', html: session.draftBlocks.join('\n\n'), buttons: session.draftButtons?.length ? { inline_keyboard: session.draftButtons } : null, previewHtmlMode: true };
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }
  if (data === 'action_skip_caption') {
    session.pending = { kind: session.postType === 'album' ? 'album' : 'media', postType: session.postType, mediaId: session.mediaId, items: session.mediaAlbumItems, html: '', buttons: null, previewHtmlMode: true };
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, `🧾 <b>Ready to Publish!</b>\n(Without Caption)`, getConfirmMenu(session));
  }
});

// ---------------- MESSAGE HANDLER (ZERO-CLICK AUTO-DETECT) ----------------
bot.on('message', async (msg) => {
  const uid = String(msg.from?.id);
  if (!isOwner(uid) || msg.from?.is_bot || msg.chat.type !== 'private') return;
  if (msg.text && /^\/(start|menu|cancel|ping)/i.test(msg.text)) return;

  const chatId = msg.chat.id;
  const session = getSession(uid);
  session.chatId = chatId;

  // AUTO REPOST DETECTION
  if (session.state === STATES.IDLE && (msg.forward_from || msg.forward_from_chat || msg.forward_origin || msg.forward_date)) {
    try {
      if (bot.copyMessage) await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      else await bot.forwardMessage(CHANNEL_ID, chatId, msg.message_id);
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return updateUI(chatId, uid, `✅ <b>Message Reposted Automatically!</b> 🚀`, MAIN_MENU);
    } catch (e) {
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return updateUI(chatId, uid, `❌ <b>Copy failed:</b> Protected content.`, CANCEL_MENU);
    }
  }

  // AUTO MEDIA / TEXT DETECTION
  if (session.state === STATES.IDLE) {
    if (msg.media_group_id || extractSingleMedia(msg)) {
      session.mode = 'media';
      session.state = STATES.WAIT_MEDIA;
      // Let it fall through
    } else if (msg.text) {
      session.mode = 'quick';
      const { textOnly, buttons } = parseButtonsBlock(msg.text);
      session.pending = { kind: 'text', rawHtml: textOnly, html: escapeHtml(textOnly), buttons: buttons.length ? { inline_keyboard: buttons } : null, previewHtmlMode: true };
      session.selectedStyle = 'normal';
      session.state = STATES.WAIT_CONFIRM;
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return updateUI(chatId, uid, `⚡ <b>Smart Input Detected!</b>\n\n${renderPendingPreview(session)}`, getConfirmMenu(session));
    } else {
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return;
    }
  }

  // MEDIA HANDLER
  if (session.state === STATES.WAIT_MEDIA) {
    if (msg.media_group_id) {
      const item = extractAlbumItem(msg);
      if (!item) { if (GHOST_MODE) await safeDelete(chatId, msg.message_id); return updateUI(chatId, uid, `⚠️ Album হিসেবে শুধু Photo/Video সাপোর্টেড।`, CANCEL_MENU); }
      if (session.album.id !== msg.media_group_id) { clearAlbumTimer(session); session.album.id = msg.media_group_id; session.album.items =[]; }
      session.album.items.push(item);
      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      return scheduleFinalizeAlbum(uid);
    }

    const media = extractSingleMedia(msg);
    if (!media) { if (GHOST_MODE) await safeDelete(chatId, msg.message_id); return updateUI(chatId, uid, `⚠️ <b>ভুল ইনপুট</b>\nMedia/File পাঠান।`, CANCEL_MENU); }
    
    session.mediaId = media.mediaId; session.postType = media.postType; session.mediaAlbumItems = null;
    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

    if (['sticker', 'video_note'].includes(session.postType)) {
      session.pending = { kind: 'media', postType: session.postType, mediaId: session.mediaId, html: '', buttons: null, previewHtmlMode: true };
      session.state = STATES.WAIT_CONFIRM;
      return updateUI(chatId, uid, `🧾 <b>Preview</b>\n\nThis media type has no caption.`, getConfirmMenu(session));
    }

    session.state = STATES.WAIT_STYLE;
    return updateUI(chatId, uid, `✅ <b>Media received!</b>\n\nএখন caption style নির্বাচন করুন:`, getStyleMenu(session));
  }

  if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
  const rawText = msg.text || msg.caption || '';
  if (!rawText.trim() && session.selectedStyle !== 'divider') return updateUI(chatId, uid, `⚠️ <b>টেক্সট পাওয়া যায়নি</b>\nটেক্সট লিখে পাঠান।`, CANCEL_MENU);

  const { textOnly, buttons } = parseButtonsBlock(rawText);
  const plainText = textOnly.trim();
  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : null;

  // RAW HANDLER
  if (session.state === STATES.WAIT_RAW) {
    session.pending = { kind: 'text', html: plainText, rawHtml: plainText, buttons: replyMarkup, previewHtmlMode: false };
    session.state = STATES.WAIT_CONFIRM;
    return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
  }

  // TEXT HANDLER
  if (session.state === STATES.WAIT_TEXT) {
    let htmlBlock;
    if (session.selectedStyle === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (parts.length < 2 || !normalizeUrl(parts[1])) return updateUI(chatId, uid, `⚠️ <b>Link format ভুল বা Invalid URL</b>\n<code>Text | https://example.com</code>`, getEditorMenu(session.selectedStyle));
      htmlBlock = `<a href="${escapeHtml(normalizeUrl(parts[1]))}">${escapeHtml(parts[0])}</a>`;
    } else {
      htmlBlock = buildStyledHtml(session.selectedStyle, plainText);
    }

    if (session.mode === 'multi') {
      session.draftBlocks.push(htmlBlock);
      if (buttons.length) session.draftButtons = buttons;
      session.state = STATES.WAIT_STYLE;
      return updateUI(chatId, uid, `🧱 <b>Block added!</b>\n\nবর্তমানে: <b>${session.draftBlocks.length}</b> blocks.\nপরবর্তী style নির্বাচন করুন অথবা Publish করুন:`, getStyleMenu(session));
    }

    if (session.mode === 'quick' && session.postType === 'text') {
      session.pending = { kind: 'text', html: htmlBlock, rawHtml: plainText, buttons: replyMarkup, previewHtmlMode: true };
      session.state = STATES.WAIT_CONFIRM;
      return updateUI(chatId, uid, renderPendingPreview(session), getConfirmMenu(session));
    }

    if (session.mode === 'media') {
      if (session.postType === 'album' && session.mediaAlbumItems?.length) {
        session.pending = { kind: 'album', items: session.mediaAlbumItems, html: htmlBlock, buttons: replyMarkup, previewHtmlMode: true };
      } else {
        if (!session.mediaId) return updateUI(chatId, uid, `⚠️ আগে media পাঠাতে হবে।`, CANCEL_MENU);
        session.pending = { kind: 'media', postType: session.postType, mediaId: session.mediaId, html: htmlBlock, buttons: replyMarkup, previewHtmlMode: true };
      }
      session.state = STATES.WAIT_CONFIRM;
      return updateUI(chatId, uid, `🧾 <b>Preview</b>\n\nCaption preview:\n\n${htmlBlock}`, getConfirmMenu(session));
    }
  }
});

// ---------------- STARTUP ----------------
async function startBot() {
  console.log('Starting Smart UI Bot...');
  await bot.deleteWebHook().catch(() => {});
  await bot.startPolling();
  await bot.setMyCommands([{ command: 'start', description: 'Open Main Menu / Restart' }]);
  console.log('Bot is live and running with Smart UX Updates!');
}
startBot();
