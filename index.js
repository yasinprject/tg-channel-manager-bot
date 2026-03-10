'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);

const GHOST_MODE = String(process.env.GHOST_MODE ?? 'true').toLowerCase() === 'true';
const UI_ANIM = String(process.env.UI_ANIM ?? 'true').toLowerCase() === 'true';

const SUCCESS_EFFECT = String(process.env.SUCCESS_EFFECT ?? 'dice').toLowerCase(); // dice|none
const DICE_EMOJI = process.env.DICE_EMOJI || '🎯';

const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || 0);
const DEFAULT_FOOTER = process.env.DEFAULT_FOOTER || '';

const STORE_FILE = process.env.STORE_FILE || './composer_store.json';
const STORE_PATH = path.resolve(process.cwd(), STORE_FILE);

const OWNER_IDS = (process.env.OWNER_IDS || process.env.OWNER_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(n => Number.isFinite(n));

function parseChannelsEnv() {
  // Preferred: CHANNELS=-100..:Main,-100..:Backup
  const raw = (process.env.CHANNELS || '').trim();
  if (raw) {
    return raw.split(',').map(tok => tok.trim()).filter(Boolean).map((tok) => {
      const [idPart, ...nameParts] = tok.split(':');
      const id = idPart.trim();
      const name = (nameParts.join(':') || id).trim();
      return { id, name };
    });
  }

  // Optional: CHANNEL_IDS=-1001,-1002
  const idsRaw = (process.env.CHANNEL_IDS || '').trim();
  if (idsRaw) {
    return idsRaw.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, name: id }));
  }

  // Backward compatible: CHANNEL_ID
  const single = (process.env.CHANNEL_ID || '').trim();
  if (single) return [{ id: single, name: single }];

  return [];
}

const CHANNELS = parseChannelsEnv();

if (!BOT_TOKEN || OWNER_IDS.length === 0 || CHANNELS.length === 0) {
  console.error('Missing env! Required: BOT_TOKEN, OWNER_IDS/OWNER_ID, and CHANNELS (or CHANNEL_ID).');
  process.exit(1);
}

const isOwner = (uid) => OWNER_IDS.includes(uid);

// ---------------- HEALTH SERVER ----------------
const app = express();
app.get('/', (_, res) => res.send('Composer Bot is running.'));
app.listen(PORT, () => console.log(`Health server :${PORT}`));

// ---------------- BOT ----------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.on('polling_error', (e) => console.error('polling_error:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));

bot.setMyCommands([
  { command: 'start', description: 'Open menu' },
  { command: 'menu', description: 'Open menu' },
  { command: 'cancel', description: 'Cancel current operation' },
]);

// ---------------- PER-USER QUEUE (Smooth: no race) ----------------
const queues = Object.create(null);
function enqueue(uid, fn) {
  queues[uid] = (queues[uid] || Promise.resolve()).then(fn).catch(err => console.error('User queue error:', err));
  return queues[uid];
}

// ---------------- STORE (Templates + Scheduled + Settings) ----------------
/**
 * store = {
 *   templates: { [uid]: [ {id,name,draft} ] },
 *   scheduled: [ {id, uid, runAt, createdAt, draftSnapshot, targetIds} ],
 *   settings: { [uid]: { targets: [channelId,...] } }
 * }
 */
let store = { templates: {}, scheduled: [], settings: {} };

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      store = {
        templates: parsed.templates || {},
        scheduled: parsed.scheduled || [],
        settings: parsed.settings || {},
      };
    }
  } catch (e) {
    console.error('Store read error:', e);
  }
}

function writeStore() {
  try {
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error('Store write error:', e);
  }
}

function rid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10);
}

readStore();

function getUserSettings(uid) {
  const key = String(uid);
  if (!store.settings[key]) {
    store.settings[key] = { targets: [CHANNELS[0].id] };
    writeStore();
  }
  // sanitize: keep only existing channels
  const available = new Set(CHANNELS.map(c => c.id));
  const targets = (store.settings[key].targets || []).filter(id => available.has(id));
  if (targets.length === 0) targets.push(CHANNELS[0].id);
  store.settings[key].targets = targets;
  return store.settings[key];
}

function setUserTargets(uid, targets) {
  const key = String(uid);
  store.settings[key] = store.settings[key] || {};
  store.settings[key].targets = targets;
  writeStore();
}

// ---------------- SESSION ----------------
const STATES = Object.freeze({
  IDLE: 'IDLE',

  COMPOSER_HOME: 'COMPOSER_HOME',
  COMPOSER_WAIT_STYLE: 'COMPOSER_WAIT_STYLE',
  COMPOSER_WAIT_TEXT: 'COMPOSER_WAIT_TEXT',
  COMPOSER_WAIT_BUTTONS: 'COMPOSER_WAIT_BUTTONS',
  COMPOSER_WAIT_RAWBLOCK: 'COMPOSER_WAIT_RAWBLOCK',
  COMPOSER_WAIT_MEDIA: 'COMPOSER_WAIT_MEDIA',

  COMPOSER_WAIT_FOOTER: 'COMPOSER_WAIT_FOOTER',
  COMPOSER_WAIT_SCHEDULE: 'COMPOSER_WAIT_SCHEDULE',
  COMPOSER_WAIT_TEMPLATE_NAME: 'COMPOSER_WAIT_TEMPLATE_NAME',

  WAIT_REPOST: 'WAIT_REPOST',
  WAIT_CONFIRM: 'WAIT_CONFIRM',

  CHANNEL_PICKER: 'CHANNEL_PICKER',
});

const sessions = Object.create(null);

function defaultSession(uid) {
  const settings = getUserSettings(uid);
  return {
    chatId: null,
    state: STATES.IDLE,
    lastMenuMsgId: null,

    composer: {
      targets: settings.targets.slice(), // multi-channel targets (persisted)
      defaultStyle: 'normal',
      blocks: [],   // [{ style, html }]
      buttons: [],  // inline_keyboard rows
      media: null,  // {kind:'single', postType, mediaId} | {kind:'album', items:[{type,media}]}

      footerEnabled: Boolean(DEFAULT_FOOTER),
      footerText: DEFAULT_FOOTER,

      scheduleAt: null, // ms UTC
    },

    selectedStyle: 'normal',
    pending: null,

    albumBuffer: { id: null, items: [], timer: null },
  };
}

function getSession(uid) {
  if (!sessions[uid]) sessions[uid] = defaultSession(uid);
  return sessions[uid];
}

function clearAlbumTimer(session) {
  if (session?.albumBuffer?.timer) {
    clearTimeout(session.albumBuffer.timer);
    session.albumBuffer.timer = null;
  }
}

function resetSession(uid, keepMenuId = true) {
  const lastMenuMsgId = sessions[uid]?.lastMenuMsgId ?? null;
  const chatId = sessions[uid]?.chatId ?? null;
  clearAlbumTimer(sessions[uid]);

  sessions[uid] = defaultSession(uid);
  sessions[uid].chatId = chatId;
  if (keepMenuId) sessions[uid].lastMenuMsgId = lastMenuMsgId;
}

// ---------------- UTIL ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function safeDelete(chatId, msgId) {
  try { await bot.deleteMessage(chatId, msgId); } catch (_) {}
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
  const idx = lines.findIndex(l => l.trim().toUpperCase() === 'BUTTONS:');
  if (idx === -1) return { textOnly: raw.trim(), buttons: [] };

  const textOnly = lines.slice(0, idx).join('\n').trim();
  const btnLines = lines.slice(idx + 1).map(l => l.trim()).filter(Boolean);

  const buttons = [];
  for (const line of btnLines) {
    const partsInRow = line.split('||').map(x => x.trim()).filter(Boolean);
    const row = [];
    for (const item of partsInRow) {
      const [labelRaw, urlRaw] = item.split('|').map(x => (x || '').trim());
      const url = normalizeUrl(urlRaw);
      if (!labelRaw || !url) continue;
      row.push({ text: labelRaw.slice(0, 64), url });
    }
    if (row.length) buttons.push(row);
  }
  return { textOnly, buttons };
}

function buildStyledHtml(style, plainText) {
  const text = String(plainText || '');
  const safe = escapeHtml(text);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  switch (style) {
    case 'normal':       return safe;
    case 'title':        return `<b>${escapeHtml(text.toUpperCase())}</b>\n────────────────────`;
    case 'bold':         return `<b>${safe}</b>`;
    case 'italic':       return `<i>${safe}</i>`;
    case 'underline':    return `<u>${safe}</u>`;
    case 'strike':       return `<s>${safe}</s>`;
    case 'spoiler':      return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code':         return `<code>${safe}</code>`;
    case 'pre':          return `<pre>${safe}</pre>`;
    case 'quote':        return `<blockquote>${safe}</blockquote>`;
    case 'expand_quote': return `<blockquote expandable>${safe}</blockquote>`;
    case 'heading':      return `<b>${safe}</b>\n────────────`;
    case 'bullets':      return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'numbered':     return lines.map((l, i) => `<b>${i + 1}.</b> ${escapeHtml(l)}`).join('\n');
    case 'note':         return `<b>Note:</b> ${safe}`;
    case 'warning':      return `<b>Warning:</b> ${safe}`;
    case 'signature':    return `<i>— ${safe}</i>`;
    default:             return safe;
  }
}

function formatRunAt(runAtMs) {
  if (!runAtMs) return 'None';
  const local = new Date(runAtMs + TZ_OFFSET_MINUTES * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} (UTC${TZ_OFFSET_MINUTES >= 0 ? '+' : ''}${(TZ_OFFSET_MINUTES/60)})`;
}

// ---------------- SCHEDULE PARSER ----------------
function parseScheduleInput(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const now = Date.now();

  let m = s.match(/^(?:in\s*)?(\d+)\s*(m|h|d)$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const delta = unit === 'm' ? n * 60e3 : unit === 'h' ? n * 3600e3 : n * 86400e3;
    return now + delta;
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), hh = Number(m[4]), mm = Number(m[5]);
    const utcMs = Date.UTC(y, mo - 1, d, hh, mm) - TZ_OFFSET_MINUTES * 60000;
    return utcMs;
  }

  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Number(m[1]), mm = Number(m[2]);
    const localNow = new Date(now + TZ_OFFSET_MINUTES * 60000);
    const y = localNow.getUTCFullYear();
    const mo = localNow.getUTCMonth();
    const d = localNow.getUTCDate();
    let utcMs = Date.UTC(y, mo, d, hh, mm) - TZ_OFFSET_MINUTES * 60000;
    if (utcMs <= now) utcMs = Date.UTC(y, mo, d + 1, hh, mm) - TZ_OFFSET_MINUTES * 60000;
    return utcMs;
  }

  return null;
}

// ---------------- UI ----------------
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: 'All-in-One Composer', callback_data: 'go_composer' }],
    [
      { text: 'Repost / Copy', callback_data: 'go_repost' },
      { text: 'Scheduled', callback_data: 'go_scheduled' },
    ],
    [{ text: 'Templates', callback_data: 'go_templates_root' }],
    [{ text: 'Help', callback_data: 'go_help' }],
    [{ text: 'Reset', callback_data: 'reset' }],
  ],
};

function channelNameById(id) {
  return CHANNELS.find(c => c.id === id)?.name || id;
}

function targetsLabel(session) {
  const t = session.composer.targets || [];
  if (!t.length) return 'Targets: none';
  if (t.length <= 2) return `Targets: ${t.map(channelNameById).join(', ')}`;
  return `Targets: ${t.length} channels`;
}

function composerMenu(session) {
  const hasMedia = Boolean(session.composer.media);
  const mediaLabel = hasMedia ? 'Replace Media' : 'Add Media/File/Album';
  const removeMediaRow = hasMedia ? [[{ text: 'Remove Media', callback_data: 'c_media_remove' }]] : [];

  const footerLabel = session.composer.footerEnabled ? 'Footer: ON' : 'Footer: OFF';
  const scheduleLabel = session.composer.scheduleAt ? `Schedule: ${formatRunAt(session.composer.scheduleAt)}` : 'Schedule: Not set';

  return {
    inline_keyboard: [
      [{ text: targetsLabel(session), callback_data: 'c_channels' }],
      [
        { text: 'Add Text', callback_data: 'c_add_text' },
        { text: mediaLabel, callback_data: 'c_add_media' },
      ],
      ...removeMediaRow,
      [
        { text: 'Buttons', callback_data: 'c_buttons' },
        { text: 'Add Raw HTML Block', callback_data: 'c_rawblock' },
      ],
      [
        { text: footerLabel, callback_data: 'c_footer_toggle' },
        { text: 'Edit Footer', callback_data: 'c_footer_edit' },
      ],
      [{ text: scheduleLabel, callback_data: 'c_schedule' }],
      [
        { text: 'Templates', callback_data: 'c_templates_root' },
        { text: 'Scheduled List', callback_data: 'c_scheduled_list' },
      ],
      [
        { text: 'Preview', callback_data: 'c_preview' },
        { text: session.composer.scheduleAt ? 'Schedule Publish' : 'Publish Now', callback_data: 'c_publish' },
      ],
      [
        { text: 'Undo Last', callback_data: 'c_undo' },
        { text: 'Clear Draft', callback_data: 'c_clear' },
      ],
      [{ text: 'Exit to Menu', callback_data: 'cancel' }],
    ],
  };
}

function confirmMenu(session) {
  const isScheduled = Boolean(session.composer.scheduleAt);
  return {
    inline_keyboard: [
      [
        { text: isScheduled ? 'Confirm Schedule' : 'Confirm Publish', callback_data: 'confirm_publish' },
        { text: 'Back', callback_data: 'confirm_back' },
      ],
      [{ text: 'Exit', callback_data: 'cancel' }],
    ],
  };
}

const BACK_MENU = { inline_keyboard: [[{ text: 'Back', callback_data: 'confirm_back' }]] };

const STYLES = [
  { id: 'normal', text: 'Normal' }, { id: 'title', text: 'Title' }, { id: 'heading', text: 'Heading' },
  { id: 'bold', text: 'Bold' }, { id: 'italic', text: 'Italic' }, { id: 'underline', text: 'Underline' },
  { id: 'strike', text: 'Strike' }, { id: 'quote', text: 'Quote' }, { id: 'expand_quote', text: 'Exp Quote' },
  { id: 'spoiler', text: 'Spoiler' }, { id: 'code', text: 'Inline Code' }, { id: 'pre', text: 'Code Block' },
  { id: 'bullets', text: 'Bullets' }, { id: 'numbered', text: 'Numbered' }, { id: 'note', text: 'Note' },
  { id: 'warning', text: 'Warning' }, { id: 'link', text: 'Text Link' }, { id: 'signature', text: 'Signature' },
];

function getStyleMenu() {
  const kb = [];
  for (let i = 0; i < STYLES.length; i += 3) {
    kb.push([
      { text: STYLES[i].text, callback_data: `c_style_${STYLES[i].id}` },
      ...(STYLES[i + 1] ? [{ text: STYLES[i + 1].text, callback_data: `c_style_${STYLES[i + 1].id}` }] : []),
      ...(STYLES[i + 2] ? [{ text: STYLES[i + 2].text, callback_data: `c_style_${STYLES[i + 2].id}` }] : []),
    ]);
  }
  kb.push([{ text: 'Back', callback_data: 'confirm_back' }]);
  return { inline_keyboard: kb };
}

function channelPickerMenu(session) {
  const selected = new Set(session.composer.targets || []);
  const kb = [];

  for (let i = 0; i < CHANNELS.length; i++) {
    const c = CHANNELS[i];
    const mark = selected.has(c.id) ? '✅' : '⬜';
    kb.push([{ text: `${mark} ${c.name}`, callback_data: `ch_t_${i}` }]);
  }

  kb.push([
    { text: 'Select All', callback_data: 'ch_all' },
    { text: 'Select None', callback_data: 'ch_none' },
  ]);
  kb.push([{ text: 'Back', callback_data: 'confirm_back' }]);

  return { inline_keyboard: kb };
}

async function updateUI(chatId, uid, text, markup) {
  const session = getSession(uid);
  const payload = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(markup ? { reply_markup: markup } : {}),
  };

  if (session.lastMenuMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: session.lastMenuMsgId, ...payload });
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

async function clearInlineKeyboard(chatId, uid) {
  const session = getSession(uid);
  if (!session.lastMenuMsgId) return;
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: session.lastMenuMsgId });
  } catch (_) {}
}

// ---------------- Supported Animations ----------------
async function animateSpinner(chatId, uid, baseTitle, ms = 850) {
  if (!UI_ANIM) return;
  const session = getSession(uid);
  if (!session.lastMenuMsgId) return;

  const frames = ['|', '/', '-', '\\'];
  const start = Date.now();
  let i = 0;

  while (Date.now() - start < ms) {
    const t = `${escapeHtml(baseTitle)}  <code>${frames[i++ % frames.length]}</code>`;
    try {
      await bot.editMessageText(t, {
        chat_id: chatId,
        message_id: session.lastMenuMsgId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch {
      break;
    }
    await sleep(260);
  }
}

async function animateProgress(chatId, uid, title, steps = 6) {
  if (!UI_ANIM) return;
  const session = getSession(uid);
  if (!session.lastMenuMsgId) return;

  for (let i = 0; i <= steps; i++) {
    const pct = Math.round((i / steps) * 100);
    const filled = Math.round((i / steps) * 10);
    const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);

    const text = `<b>${escapeHtml(title)}</b>\n\n<code>${bar} ${pct}%</code>`;
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: session.lastMenuMsgId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch {
      break;
    }
    await sleep(420);
  }
}

async function successEffect(chatId) {
  if (SUCCESS_EFFECT === 'none') return;
  if (SUCCESS_EFFECT === 'dice') {
    try { await bot.sendDice(chatId, { emoji: DICE_EMOJI }); } catch (_) {}
  }
}

function chatActionForMedia(media) {
  if (!media) return 'typing';
  if (media.kind === 'album') return 'upload_photo';
  switch (media.postType) {
    case 'photo': return 'upload_photo';
    case 'video': return 'upload_video';
    case 'document': return 'upload_document';
    case 'audio': return 'upload_audio';
    case 'voice': return 'upload_voice';
    case 'animation': return 'upload_document';
    case 'sticker': return 'choose_sticker';
    case 'video_note': return 'upload_video_note';
    default: return 'typing';
  }
}

// ---------------- COMPOSER HELPERS ----------------
function composerSummary(session) {
  const c = session.composer;

  const mediaText = !c.media ? 'None'
    : (c.media.kind === 'album' ? `Album (${c.media.items.length})` : `Single (${c.media.postType})`);

  const blocks = c.blocks.length;
  const btnRows = c.buttons.length;

  const footerText = c.footerEnabled ? (c.footerText ? 'ON' : 'ON (empty)') : 'OFF';
  const scheduleText = c.scheduleAt ? formatRunAt(c.scheduleAt) : 'Not set';
  const targetsText = (c.targets || []).map(channelNameById).join(', ') || 'none';

  return (
`<b>All-in-One Composer</b>
────────────────────
Targets: <b>${escapeHtml(targetsText)}</b>
Media: <b>${escapeHtml(mediaText)}</b>
Text blocks: <b>${blocks}</b>
Buttons rows: <b>${btnRows}</b>
Footer: <b>${escapeHtml(footerText)}</b>
Schedule: <b>${escapeHtml(scheduleText)}</b>

Tip: Composer screen এ থাকলে সরাসরি টেক্সট পাঠালেও Normal block যোগ হবে।`
  );
}

function buildComposerHtml(session) {
  const c = session.composer;
  let html = c.blocks.map(b => b.html).join('\n\n').trim();

  if (c.footerEnabled && c.footerText && c.footerText.trim()) {
    const footerHtml = `<i>${escapeHtml(c.footerText.trim())}</i>`;
    html = html ? (html + '\n\n' + footerHtml) : footerHtml;
  }
  return html;
}

function buildButtonsMarkup(session) {
  const c = session.composer;
  return c.buttons.length ? { inline_keyboard: c.buttons } : null;
}

function snapshotDraft(session) {
  return JSON.parse(JSON.stringify({
    targets: session.composer.targets,
    blocks: session.composer.blocks,
    buttons: session.composer.buttons,
    media: session.composer.media,
    footerEnabled: session.composer.footerEnabled,
    footerText: session.composer.footerText,
  }));
}

function restoreDraft(session, draft) {
  session.composer.targets = (draft.targets && draft.targets.length) ? draft.targets : session.composer.targets;
  session.composer.blocks = draft.blocks || [];
  session.composer.buttons = draft.buttons || [];
  session.composer.media = draft.media || null;
  session.composer.footerEnabled = Boolean(draft.footerEnabled);
  session.composer.footerText = draft.footerText || '';
  session.composer.scheduleAt = null;
  // persist targets choice
  setUserTargets(session._uid, session.composer.targets);
}

// ---------------- MEDIA EXTRACTION ----------------
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
  const chatId = session.chatId;
  clearAlbumTimer(session);

  session.albumBuffer.timer = setTimeout(async () => {
    const items = session.albumBuffer.items.slice();
    session.albumBuffer.id = null;
    session.albumBuffer.items = [];
    session.albumBuffer.timer = null;

    if (!items.length) return;

    session.composer.media = { kind: 'album', items };
    session.state = STATES.COMPOSER_HOME;

    await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
  }, 1200);
}

// ---------------- MULTI-TARGET PUBLISH ENGINE ----------------
async function sendLongTextToTarget(chatId, html, replyMarkup) {
  const MAX = 4096;
  if (!html || !html.trim()) html = ' ';
  if (html.length <= MAX) {
    return bot.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      disable_web_page_preview: true,
    });
  }

  const parts = html.split(/\n{2,}/g).filter(Boolean);
  if (parts.length <= 1) throw new Error('Text too long to split safely.');

  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    if (chunk.length > MAX) throw new Error('A block is too long.');
    await bot.sendMessage(chatId, chunk, {
      parse_mode: 'HTML',
      ...(i === parts.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
      disable_web_page_preview: true,
    });
  }
}

function captionLimit(postType) {
  if (['sticker', 'video_note'].includes(postType)) return 0;
  return 1024;
}

async function sendSingleToTarget(chatId, postType, mediaId, captionHtml, buttons) {
  const limit = captionLimit(postType);
  const hasCaption = Boolean(captionHtml && captionHtml.trim());
  const tooLong = hasCaption && limit > 0 && captionHtml.length > limit;

  if (tooLong) {
    await sendSingleToTarget(chatId, postType, mediaId, '', null);
    await sendLongTextToTarget(chatId, captionHtml, buttons);
    return;
  }

  const opts = {
    ...(limit > 0 && hasCaption ? { caption: captionHtml, parse_mode: 'HTML' } : {}),
    ...(buttons ? { reply_markup: buttons } : {}),
    disable_web_page_preview: true,
  };

  switch (postType) {
    case 'photo': return bot.sendPhoto(chatId, mediaId, opts);
    case 'video': return bot.sendVideo(chatId, mediaId, opts);
    case 'document': return bot.sendDocument(chatId, mediaId, opts);
    case 'audio': return bot.sendAudio(chatId, mediaId, opts);
    case 'voice': return bot.sendVoice(chatId, mediaId, opts);
    case 'animation': return bot.sendAnimation(chatId, mediaId, opts);

    case 'sticker':
      await bot.sendSticker(chatId, mediaId);
      if (hasCaption || buttons) await sendLongTextToTarget(chatId, captionHtml || 'Links', buttons);
      return;

    case 'video_note':
      await bot.sendVideoNote(chatId, mediaId);
      if (hasCaption || buttons) await sendLongTextToTarget(chatId, captionHtml || 'Links', buttons);
      return;

    default:
      throw new Error(`Unsupported type: ${postType}`);
  }
}

async function sendAlbumToTarget(chatId, items, captionHtml, buttons) {
  const hasButtons = Boolean(buttons);
  const hasCaption = Boolean(captionHtml && captionHtml.trim());

  // Telegram limitation: no reply_markup in sendMediaGroup
  if (hasButtons) {
    await bot.sendMediaGroup(chatId, items.map(x => ({ type: x.type, media: x.media })));
    await sendLongTextToTarget(chatId, hasCaption ? captionHtml : 'Links', buttons);
    return;
  }

  const CAPTION_MAX = 1024;
  if (hasCaption && captionHtml.length > CAPTION_MAX) {
    await bot.sendMediaGroup(chatId, items.map(x => ({ type: x.type, media: x.media })));
    await sendLongTextToTarget(chatId, captionHtml, null);
    return;
  }

  const payload = items.map((x, i) => (
    i === 0 && hasCaption
      ? { type: x.type, media: x.media, caption: captionHtml, parse_mode: 'HTML' }
      : { type: x.type, media: x.media }
  ));
  await bot.sendMediaGroup(chatId, payload);
}

async function publishDraftSnapshotToTargets(draftSnapshot, targetIds) {
  const targets = (targetIds && targetIds.length) ? targetIds : [CHANNELS[0].id];

  const htmlBlocks = (draftSnapshot.blocks || []).map(b => b.html).join('\n\n').trim();
  let finalHtml = htmlBlocks;

  if (draftSnapshot.footerEnabled && draftSnapshot.footerText && draftSnapshot.footerText.trim()) {
    const footerHtml = `<i>${escapeHtml(draftSnapshot.footerText.trim())}</i>`;
    finalHtml = finalHtml ? (finalHtml + '\n\n' + footerHtml) : footerHtml;
  }

  const buttons = draftSnapshot.buttons?.length ? { inline_keyboard: draftSnapshot.buttons } : null;
  const media = draftSnapshot.media;

  for (const t of targets) {
    if (!media) await sendLongTextToTarget(t, finalHtml, buttons);
    else if (media.kind === 'album') await sendAlbumToTarget(t, media.items, finalHtml, buttons);
    else await sendSingleToTarget(t, media.postType, media.mediaId, finalHtml, buttons);
  }
}

async function publishComposer(session) {
  const targets = session.composer.targets || [];
  if (!targets.length) throw new Error('No target channels selected.');

  const html = buildComposerHtml(session);
  const buttons = buildButtonsMarkup(session);
  const media = session.composer.media;

  for (const t of targets) {
    if (!media) await sendLongTextToTarget(t, html, buttons);
    else if (media.kind === 'album') await sendAlbumToTarget(t, media.items, html, buttons);
    else await sendSingleToTarget(t, media.postType, media.mediaId, html, buttons);
  }
}

// ---------------- SCHEDULER (persistent) ----------------
let schedulerBusy = false;
async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const now = Date.now();
    const due = store.scheduled.filter(j => j.runAt <= now).sort((a, b) => a.runAt - b.runAt);

    for (const job of due) {
      try {
        await publishDraftSnapshotToTargets(job.draftSnapshot, job.targetIds);
      } catch (e) {
        console.error('Scheduled publish failed:', job.id, e?.message || e);
      } finally {
        store.scheduled = store.scheduled.filter(x => x.id !== job.id);
        writeStore();
      }
    }
  } finally {
    schedulerBusy = false;
  }
}
setInterval(schedulerTick, 10_000);

// ---------------- TEMPLATES + SCHEDULED UI ----------------
function getTemplates(uid) {
  return store.templates[String(uid)] || [];
}
function setTemplates(uid, arr) {
  store.templates[String(uid)] = arr;
  writeStore();
}

function templatesRootMenu() {
  return {
    inline_keyboard: [
      [
        { text: 'Save Current Draft', callback_data: 'tpl_save' },
        { text: 'Load Template', callback_data: 'tpl_load_list' },
      ],
      [{ text: 'Delete Template', callback_data: 'tpl_delete_list' }],
      [{ text: 'Back', callback_data: 'cancel' }],
    ],
  };
}

function templatesListMenu(uid, mode) {
  const items = getTemplates(uid);
  if (!items.length) {
    return { inline_keyboard: [[{ text: 'No templates', callback_data: 'noop' }], [{ text: 'Back', callback_data: 'c_templates_root' }]] };
  }
  const kb = items.slice(0, 12).map(t => ([{ text: t.name.slice(0, 30), callback_data: `${mode}_${t.id}` }]));
  kb.push([{ text: 'Back', callback_data: 'c_templates_root' }]);
  return { inline_keyboard: kb };
}

function scheduledListMenu(uid) {
  const jobs = store.scheduled.filter(j => String(j.uid) === String(uid)).sort((a, b) => a.runAt - b.runAt);
  if (!jobs.length) {
    return { inline_keyboard: [[{ text: 'No scheduled posts', callback_data: 'noop' }], [{ text: 'Back', callback_data: 'cancel' }]] };
  }
  const kb = jobs.slice(0, 12).map(j => ([{ text: `Cancel: ${formatRunAt(j.runAt)} (${(j.targetIds||[]).length} ch)`.slice(0, 60), callback_data: `sch_cancel_${j.id}` }]));
  kb.push([{ text: 'Back', callback_data: 'cancel' }]);
  return { inline_keyboard: kb };
}

// ---------------- COMMANDS ----------------
async function openMainMenu(chatId, uid) {
  const session = getSession(uid);
  session._uid = uid;
  session.chatId = chatId;
  session.state = STATES.IDLE;
  session.pending = null;

  await updateUI(chatId, uid, `<b>Channel Manager</b>\n────────────────────\nSelect an action:`, MAIN_MENU);
}

async function openComposer(chatId, uid) {
  const session = getSession(uid);
  session._uid = uid;
  session.chatId = chatId;
  session.state = STATES.COMPOSER_HOME;
  session.pending = null;
  session.selectedStyle = session.composer.defaultStyle;

  // sync from persisted settings
  session.composer.targets = getUserSettings(uid).targets.slice();

  await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
}

function ensurePrivateOwner(msgOrQuery) {
  const uid = msgOrQuery.from?.id;
  const chatType = msgOrQuery.chat?.type || msgOrQuery.message?.chat?.type;
  return isOwner(uid) && chatType === 'private';
}

bot.onText(/^\/start$/i, async (msg) => {
  if (!ensurePrivateOwner(msg)) return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;

  await enqueue(uid, async () => {
    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
    resetSession(uid, true);
    await openMainMenu(chatId, uid);
  });
});

bot.onText(/^\/menu$/i, async (msg) => {
  if (!ensurePrivateOwner(msg)) return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;

  await enqueue(uid, async () => {
    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
    await openMainMenu(chatId, uid);
  });
});

bot.onText(/^\/cancel$/i, async (msg) => {
  if (!ensurePrivateOwner(msg)) return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;

  await enqueue(uid, async () => {
    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
    resetSession(uid, true);
    await openMainMenu(chatId, uid);
  });
});

// ---------------- CALLBACKS ----------------
bot.on('callback_query', async (q) => {
  const uid = q.from?.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(q.id, { text: 'Not allowed', show_alert: true });

  const msg = q.message;
  if (!msg || msg.chat.type !== 'private') return bot.answerCallbackQuery(q.id, { text: 'Use private chat', show_alert: true });

  const chatId = msg.chat.id;
  const data = q.data;
  const session = getSession(uid);
  session._uid = uid;
  session.chatId = chatId;

  bot.answerCallbackQuery(q.id).catch(() => {});

  await enqueue(uid, async () => {
    if (data === 'noop') return;

    if (data === 'reset' || data === 'cancel') {
      resetSession(uid, true);
      await openMainMenu(chatId, uid);
      return;
    }

    if (data === 'go_help') {
      await updateUI(chatId, uid,
        `<b>Help</b>
────────────────────
Multi-channel:
- Composer → Targets লাইনে ক্লিক করে channels select করুন।

Buttons:
<pre>BUTTONS:
Google | https://google.com
A | https://a.com || B | https://b.com</pre>

Schedule input:
- <code>10m</code>, <code>2h</code>, <code>1d</code>
- <code>YYYY-MM-DD HH:mm</code>
- <code>HH:mm</code>

Note: Album এ Buttons দিলে, album এর পরে আলাদা message এ Buttons যাবে।`,
        { inline_keyboard: [[{ text: 'Back', callback_data: 'cancel' }]] }
      );
      return;
    }

    if (data === 'go_scheduled') {
      await updateUI(chatId, uid, `<b>Scheduled Posts</b>\n────────────────────`, scheduledListMenu(uid));
      return;
    }

    if (data.startsWith('sch_cancel_')) {
      const id = data.replace('sch_cancel_', '');
      store.scheduled = store.scheduled.filter(j => !(j.id === id && String(j.uid) === String(uid)));
      writeStore();
      await updateUI(chatId, uid, `<b>Cancelled</b>\n────────────────────`, scheduledListMenu(uid));
      return;
    }

    if (data === 'go_templates_root') {
      await updateUI(chatId, uid, `<b>Templates</b>\n────────────────────`, templatesRootMenu());
      return;
    }

    if (data === 'go_composer') {
      await openComposer(chatId, uid);
      return;
    }

    if (data === 'go_repost') {
      session.state = STATES.WAIT_REPOST;
      await updateUI(chatId, uid,
        `<b>Repost / Copy</b>
────────────────────
যে message কপি করতে চান সেটা forward/send করুন।
(Selected targets: ${escapeHtml((getUserSettings(uid).targets||[]).map(channelNameById).join(', '))})`,
        { inline_keyboard: [[{ text: 'Back', callback_data: 'cancel' }]] }
      );
      return;
    }

    // ---- Channel picker ----
    if (data === 'c_channels') {
      session.state = STATES.CHANNEL_PICKER;
      await updateUI(chatId, uid, `<b>Select Target Channels</b>\n────────────────────\nযে চ্যানেলগুলোতে পোস্ট যাবে সেগুলো টিক দিন:`, channelPickerMenu(session));
      return;
    }
    if (data.startsWith('ch_t_')) {
      const idx = Number(data.replace('ch_t_', ''));
      const c = CHANNELS[idx];
      if (!c) return;
      const set = new Set(session.composer.targets || []);
      if (set.has(c.id)) set.delete(c.id); else set.add(c.id);
      const next = Array.from(set);
      session.composer.targets = next.length ? next : [CHANNELS[0].id];
      setUserTargets(uid, session.composer.targets);
      await updateUI(chatId, uid, `<b>Select Target Channels</b>\n────────────────────`, channelPickerMenu(session));
      return;
    }
    if (data === 'ch_all') {
      session.composer.targets = CHANNELS.map(c => c.id);
      setUserTargets(uid, session.composer.targets);
      await updateUI(chatId, uid, `<b>Select Target Channels</b>\n────────────────────`, channelPickerMenu(session));
      return;
    }
    if (data === 'ch_none') {
      session.composer.targets = [CHANNELS[0].id];
      setUserTargets(uid, session.composer.targets);
      await updateUI(chatId, uid, `<b>Select Target Channels</b>\n────────────────────\n(At least 1 channel required)`, channelPickerMenu(session));
      return;
    }

    // ---- Composer actions ----
    if (data === 'c_add_text') {
      session.state = STATES.COMPOSER_WAIT_STYLE;
      await updateUI(chatId, uid, `<b>Add Text Block</b>\n────────────────────\nএকটি style সিলেক্ট করুন:`, getStyleMenu());
      return;
    }

    if (data.startsWith('c_style_')) {
      const style = data.replace('c_style_', '');
      session.selectedStyle = style;
      session.state = STATES.COMPOSER_WAIT_TEXT;

      const styleName = STYLES.find(s => s.id === style)?.text || style;
      await updateUI(chatId, uid,
        `<b>Text Input</b>
────────────────────
Selected: <b>${escapeHtml(styleName)}</b>

Text পাঠান।
Optional Buttons:
<pre>BUTTONS:
Name | https://url</pre>`,
        BACK_MENU
      );
      return;
    }

    if (data === 'c_add_media') {
      session.state = STATES.COMPOSER_WAIT_MEDIA;
      await updateUI(chatId, uid,
        `<b>Add / Replace Media</b>
────────────────────
যেকোনো media/file পাঠান।
Album: একসাথে একাধিক photo/video পাঠান (Telegram album)।`,
        BACK_MENU
      );
      return;
    }

    if (data === 'c_media_remove') {
      session.composer.media = null;
      await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      return;
    }

    if (data === 'c_buttons') {
      session.state = STATES.COMPOSER_WAIT_BUTTONS;
      await updateUI(chatId, uid,
        `<b>Buttons</b>
────────────────────
Send:
<pre>BUTTONS:
Google | https://google.com
A | https://a.com || B | https://b.com</pre>

Remove: <code>CLEAR</code>`,
        BACK_MENU
      );
      return;
    }

    if (data === 'c_rawblock') {
      session.state = STATES.COMPOSER_WAIT_RAWBLOCK;
      await updateUI(chatId, uid,
        `<b>Add Raw HTML Block</b>
────────────────────
HTML পাঠান (parse_mode HTML)।
Buttons optional (BUTTONS: block)।`,
        BACK_MENU
      );
      return;
    }

    if (data === 'c_footer_toggle') {
      session.composer.footerEnabled = !session.composer.footerEnabled;
      await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      return;
    }

    if (data === 'c_footer_edit') {
      session.state = STATES.COMPOSER_WAIT_FOOTER;
      await updateUI(chatId, uid,
        `<b>Edit Footer</b>
────────────────────
Footer text পাঠান (plain text)।
Remove করতে: <code>CLEAR</code>`,
        BACK_MENU
      );
      return;
    }

    if (data === 'c_schedule') {
      session.state = STATES.COMPOSER_WAIT_SCHEDULE;
      await updateUI(chatId, uid,
        `<b>Schedule Publish</b>
────────────────────
Time পাঠান:
- <code>10m</code>, <code>2h</code>, <code>1d</code>
- <code>YYYY-MM-DD HH:mm</code>
- <code>HH:mm</code>

Unset করতে: <code>CLEAR</code>

Timezone: <b>UTC${TZ_OFFSET_MINUTES >= 0 ? '+' : ''}${TZ_OFFSET_MINUTES/60}</b>`,
        BACK_MENU
      );
      return;
    }

    if (data === 'c_templates_root') {
      await updateUI(chatId, uid, `<b>Templates</b>\n────────────────────`, templatesRootMenu());
      return;
    }

    if (data === 'tpl_save') {
      session.state = STATES.COMPOSER_WAIT_TEMPLATE_NAME;
      await updateUI(chatId, uid,
        `<b>Save Template</b>
────────────────────
Template name পাঠান (1-30 chars)।`,
        { inline_keyboard: [[{ text: 'Back', callback_data: 'c_templates_root' }]] }
      );
      return;
    }

    if (data === 'tpl_load_list') {
      await updateUI(chatId, uid, `<b>Load Template</b>\n────────────────────`, templatesListMenu(uid, 'tpl_load'));
      return;
    }

    if (data === 'tpl_delete_list') {
      await updateUI(chatId, uid, `<b>Delete Template</b>\n────────────────────`, templatesListMenu(uid, 'tpl_del'));
      return;
    }

    if (data.startsWith('tpl_load_')) {
      const id = data.replace('tpl_load_', '');
      const tpl = getTemplates(uid).find(t => t.id === id);
      if (!tpl) return;

      restoreDraft(session, tpl.draft);
      await updateUI(chatId, uid, `<b>Loaded:</b> ${escapeHtml(tpl.name)}\n────────────────────\n` + composerSummary(session), composerMenu(session));
      return;
    }

    if (data.startsWith('tpl_del_')) {
      const id = data.replace('tpl_del_', '');
      setTemplates(uid, getTemplates(uid).filter(t => t.id !== id));
      await updateUI(chatId, uid, `<b>Deleted.</b>\n────────────────────`, templatesRootMenu());
      return;
    }

    if (data === 'c_scheduled_list') {
      await updateUI(chatId, uid, `<b>Your Scheduled Posts</b>\n────────────────────`, scheduledListMenu(uid));
      return;
    }

    if (data === 'c_undo') {
      if (session.composer.blocks.length) session.composer.blocks.pop();
      await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      return;
    }

    if (data === 'c_clear') {
      session.composer.blocks = [];
      session.composer.buttons = [];
      session.composer.media = null;
      session.composer.scheduleAt = null;

      await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      return;
    }

    if (data === 'c_preview') {
      session.state = STATES.WAIT_CONFIRM;
      session.pending = { kind: 'preview' };

      await animateSpinner(chatId, uid, 'Preparing preview');
      const html = buildComposerHtml(session);
      const media = session.composer.media;
      const btnRows = session.composer.buttons.length;
      const snippet = html.length > 1200 ? (html.slice(0, 1200) + '\n\n<i>[Preview truncated]</i>') : (html || '<i>[No text blocks]</i>');
      const mediaLine = !media ? 'Media: None' : (media.kind === 'album' ? `Media: Album (${media.items.length})` : `Media: Single (${media.postType})`);

      await updateUI(chatId, uid,
        `<b>Preview</b>
────────────────────
Targets: <b>${escapeHtml((session.composer.targets||[]).map(channelNameById).join(', '))}</b>
${escapeHtml(mediaLine)}
Buttons rows: <b>${btnRows}</b>
Footer: <b>${session.composer.footerEnabled ? 'ON' : 'OFF'}</b>
Schedule: <b>${escapeHtml(session.composer.scheduleAt ? formatRunAt(session.composer.scheduleAt) : 'Not set')}</b>

${snippet}`,
        confirmMenu(session)
      );
      return;
    }

    if (data === 'c_publish') {
      session.state = STATES.WAIT_CONFIRM;
      session.pending = { kind: 'publish' };

      await updateUI(chatId, uid,
        `<b>${session.composer.scheduleAt ? 'Schedule Publish' : 'Publish Now'}</b>
────────────────────
Confirm করলে ${session.composer.scheduleAt ? 'schedule হবে (সব target channel এ)' : 'সব target channel এ publish হবে'}।`,
        confirmMenu(session)
      );
      return;
    }

    if (data === 'confirm_back') {
      session.state = STATES.COMPOSER_HOME;
      session.pending = null;
      await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      return;
    }

    if (data === 'confirm_publish') {
      await clearInlineKeyboard(chatId, uid);

      bot.sendChatAction(chatId, chatActionForMedia(session.composer.media)).catch(() => {});
      await animateProgress(chatId, uid, session.composer.scheduleAt ? 'Scheduling' : 'Publishing');

      try {
        if (session.composer.scheduleAt) {
          const runAt = session.composer.scheduleAt;
          if (runAt <= Date.now() + 15_000) {
            await publishComposer(session);
          } else {
            const job = {
              id: rid('sch_'),
              uid,
              runAt,
              createdAt: Date.now(),
              draftSnapshot: snapshotDraft(session),
              targetIds: (session.composer.targets || []).slice(),
            };
            store.scheduled.push(job);
            writeStore();
          }
        } else {
          await publishComposer(session);
        }

        // Clear draft after action
        session.composer.blocks = [];
        session.composer.buttons = [];
        session.composer.media = null;
        session.composer.scheduleAt = null;
        session.pending = null;
        session.state = STATES.COMPOSER_HOME;

        await successEffect(chatId);

        await updateUI(chatId, uid,
          `<b>Done</b>
────────────────────
Finished for targets: <b>${escapeHtml((getUserSettings(uid).targets||[]).map(channelNameById).join(', '))}</b>`,
          composerMenu(session)
        );
      } catch (e) {
        await updateUI(chatId, uid,
          `<b>Failed</b>\n────────────────────\n${escapeHtml(e.message || 'Unknown error')}`,
          BACK_MENU
        );
      }
      return;
    }
  });
});

// ---------------- MESSAGES ----------------
bot.on('message', async (msg) => {
  if (!ensurePrivateOwner(msg)) return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.text && /^\/(start|menu|cancel)/i.test(msg.text)) return;

  await enqueue(uid, async () => {
    const session = getSession(uid);
    session._uid = uid;
    session.chatId = chatId;

    // Repost: copy to all selected targets
    if (session.state === STATES.WAIT_REPOST) {
      const targets = getUserSettings(uid).targets || [CHANNELS[0].id];
      try {
        // copy must happen before delete
        for (const t of targets) {
          await bot.copyMessage(t, chatId, msg.message_id);
        }
        if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
        resetSession(uid, true);
        await openMainMenu(chatId, uid);
      } catch {
        if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
        await updateUI(chatId, uid,
          `<b>Copy failed</b>\n────────────────────\nProtected content / no permission / invalid message.`,
          { inline_keyboard: [[{ text: 'Back', callback_data: 'cancel' }]] }
        );
      }
      return;
    }

    // Media receiving only when waiting media (Replace supported)
    if (session.state === STATES.COMPOSER_WAIT_MEDIA) {
      const groupId = msg.media_group_id;

      if (groupId) {
        const item = extractAlbumItem(msg);
        if (!item) {
          if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
          await updateUI(chatId, uid,
            `<b>Album not supported</b>\n────────────────────\nAlbum হিসেবে শুধুমাত্র photo/video supported.`,
            BACK_MENU
          );
          return;
        }

        if (session.albumBuffer.id !== groupId) {
          clearAlbumTimer(session);
          session.albumBuffer.id = groupId;
          session.albumBuffer.items = [];
        }
        session.albumBuffer.items.push(item);

        if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
        scheduleFinalizeAlbum(uid);
        return;
      }

      const single = extractSingleMedia(msg);
      if (single) {
        session.composer.media = { kind: 'single', postType: single.postType, mediaId: single.mediaId };
        session.state = STATES.COMPOSER_HOME;

        if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
        await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
        return;
      }

      if (GHOST_MODE) await safeDelete(chatId, msg.message_id);
      await updateUI(chatId, uid, `<b>Waiting for media/file</b>\n────────────────────\nMedia/File/Album পাঠান।`, BACK_MENU);
      return;
    }

    if (GHOST_MODE) await safeDelete(chatId, msg.message_id);

    // Composer HOME: direct text adds Normal block
    if (session.state === STATES.COMPOSER_HOME) {
      const raw = msg.text || msg.caption || '';
      if (!raw.trim()) return;

      const { textOnly, buttons } = parseButtonsBlock(raw);
      const plain = textOnly.trim();
      if (!plain) return;

      const html = buildStyledHtml(session.composer.defaultStyle, plain);
      session.composer.blocks.push({ style: session.composer.defaultStyle, html });
      if (buttons.length) session.composer.buttons = buttons;

      await updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      return;
    }

    // Buttons input
    if (session.state === STATES.COMPOSER_WAIT_BUTTONS) {
      const raw = (msg.text || '').trim();
      if (!raw) return updateUI(chatId, uid, 'Buttons text not found.', BACK_MENU);

      if (raw.toUpperCase() === 'CLEAR') {
        session.composer.buttons = [];
        session.state = STATES.COMPOSER_HOME;
        return updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      }

      const { buttons } = parseButtonsBlock(raw);
      if (!buttons.length) {
        return updateUI(chatId, uid,
          `<b>Buttons invalid</b>\n────────────────────\nFormat:\n<pre>BUTTONS:\nName | https://url</pre>`,
          BACK_MENU
        );
      }

      session.composer.buttons = buttons;
      session.state = STATES.COMPOSER_HOME;
      return updateUI(chatId, uid, composerSummary(session), composerMenu(session));
    }

    // Raw HTML block
    if (session.state === STATES.COMPOSER_WAIT_RAWBLOCK) {
      const raw = (msg.text || msg.caption || '').trim();
      if (!raw) return updateUI(chatId, uid, 'HTML not found.', BACK_MENU);

      const { textOnly, buttons } = parseButtonsBlock(raw);
      const html = textOnly.trim();
      if (!html) return updateUI(chatId, uid, 'HTML block empty.', BACK_MENU);

      session.composer.blocks.push({ style: 'raw', html });
      if (buttons.length) session.composer.buttons = buttons;

      session.state = STATES.COMPOSER_HOME;
      return updateUI(chatId, uid, composerSummary(session), composerMenu(session));
    }

    // Footer edit
    if (session.state === STATES.COMPOSER_WAIT_FOOTER) {
      const raw = (msg.text || '').trim();
      if (!raw) return updateUI(chatId, uid, 'Footer text not found.', BACK_MENU);

      if (raw.toUpperCase() === 'CLEAR') {
        session.composer.footerText = '';
        session.composer.footerEnabled = false;
      } else {
        session.composer.footerText = raw.slice(0, 500);
        session.composer.footerEnabled = true;
      }
      session.state = STATES.COMPOSER_HOME;
      return updateUI(chatId, uid, composerSummary(session), composerMenu(session));
    }

    // Schedule input
    if (session.state === STATES.COMPOSER_WAIT_SCHEDULE) {
      const raw = (msg.text || '').trim();
      if (!raw) return updateUI(chatId, uid, 'Time not found.', BACK_MENU);

      if (raw.toUpperCase() === 'CLEAR') {
        session.composer.scheduleAt = null;
        session.state = STATES.COMPOSER_HOME;
        return updateUI(chatId, uid, composerSummary(session), composerMenu(session));
      }

      const runAt = parseScheduleInput(raw);
      if (!runAt || runAt <= Date.now() + 30_000) {
        return updateUI(chatId, uid,
          `<b>Invalid time</b>
────────────────────
Examples:
- <code>10m</code>, <code>2h</code>, <code>1d</code>
- <code>2026-03-10 21:30</code>
- <code>21:30</code>

(এখন থেকে অন্তত 30s পরে হতে হবে)`,
          BACK_MENU
        );
      }

      session.composer.scheduleAt = runAt;
      session.state = STATES.COMPOSER_HOME;
      return updateUI(chatId, uid, composerSummary(session), composerMenu(session));
    }

    // Template save name
    if (session.state === STATES.COMPOSER_WAIT_TEMPLATE_NAME) {
      const name = (msg.text || '').trim();
      if (!name || name.length > 30) {
        return updateUI(chatId, uid, `<b>Invalid name</b>\n────────────────────\n1-30 chars দিন।`, { inline_keyboard: [[{ text: 'Back', callback_data: 'c_templates_root' }]] });
      }

      const arr = getTemplates(uid);
      const tpl = { id: rid('tpl_'), name, draft: snapshotDraft(session) };
      arr.unshift(tpl);
      setTemplates(uid, arr.slice(0, 50));

      session.state = STATES.COMPOSER_HOME;
      return updateUI(chatId, uid, `<b>Saved Template:</b> ${escapeHtml(name)}\n────────────────────\n` + composerSummary(session), composerMenu(session));
    }

    // Styled text block
    if (session.state === STATES.COMPOSER_WAIT_TEXT) {
      const raw = (msg.text || msg.caption || '').trim();
      if (!raw) return updateUI(chatId, uid, 'Text not found.', BACK_MENU);

      const { textOnly, buttons } = parseButtonsBlock(raw);
      const plain = textOnly.trim();
      if (!plain) return updateUI(chatId, uid, 'Text empty.', BACK_MENU);

      let html;
      if (session.selectedStyle === 'link') {
        const parts = plain.split('|').map(x => x.trim());
        if (parts.length < 2) {
          return updateUI(chatId, uid,
            `<b>Link format invalid</b>\n────────────────────\n<code>Text | https://example.com</code>`,
            BACK_MENU
          );
        }
        const url = normalizeUrl(parts[1]);
        if (!url) return updateUI(chatId, uid, 'Invalid URL.', BACK_MENU);
        html = `<a href="${escapeHtml(url)}">${escapeHtml(parts[0])}</a>`;
      } else {
        html = buildStyledHtml(session.selectedStyle, plain);
      }

      session.composer.blocks.push({ style: session.selectedStyle, html });
      if (buttons.length) session.composer.buttons = buttons;

      session.state = STATES.COMPOSER_HOME;
      return updateUI(chatId, uid, composerSummary(session), composerMenu(session));
    }
  });
});
