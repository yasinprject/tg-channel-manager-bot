// Clean Channel Manager Bot - Button Based UI
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;       
const OWNER_ID = Number(process.env.OWNER_ID);   
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID || !OWNER_ID) {
  console.error('❌ BOT_TOKEN / CHANNEL_ID / OWNER_ID missing in .env');
  process.exit(1);
}

// ---------- Express (for Render ping) ----------
const app = express();
app.get('/', (_req, res) => res.send('✅ Channel Manager Bot is running.'));
app.listen(PORT, () => console.log('🌐 Server on port', PORT));

// ---------- Telegram bot ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 Button-Based Bot started');

// ---------- Session Management ----------
// User States: IDLE, AWAITING_TEXT, AWAITING_RAW, AWAITING_REPOST
const sessions = {};

function getSession(uid) {
  if (!sessions[uid]) {
    sessions[uid] = {
      state: 'IDLE',
      mode: null,          // 'quick' or 'multi'
      selectedStyle: null, // 'bold', 'italic', etc.
      draftBlocks: [],
      draftButtons: [],
      lastMenuMsgId: null  // To keep chat clean
    };
  }
  return sessions[uid];
}

function resetSession(uid) {
  const lastMsg = sessions[uid]?.lastMenuMsgId;
  sessions[uid] = { state: 'IDLE', mode: null, selectedStyle: null, draftBlocks: [], draftButtons: [], lastMenuMsgId: lastMsg };
}

// ---------- Helpers ----------
function isOwner(id) {
  return id === OWNER_ID;
}

function escapeHtml(t) {
  if (!t) return '';
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseButtonsBlock(text) {
  if (!text) return { textOnly: text, buttons: [] };
  const idx = text.lastIndexOf('BUTTONS:');
  if (idx === -1) return { textOnly: text, buttons: [] };
  const before = text.slice(0, idx).trim();
  const block = text.slice(idx + 'BUTTONS:'.length).trim();
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const buttons = [];
  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length >= 2 && /^https?:\/\//i.test(parts[1])) {
      buttons.push({ text: parts[0], url: parts[1] });
    }
  }
  return { textOnly: before, buttons };
}

async function cleanPreviousMenu(chatId, uid) {
  const session = getSession(uid);
  if (session.lastMenuMsgId) {
    try {
      await bot.deleteMessage(chatId, session.lastMenuMsgId);
    } catch (e) { /* Ignore if already deleted */ }
  }
}

// ---------- Styled HTML Builder ----------
function buildStyledHtml(style, plainText) {
  const safe = escapeHtml(plainText || '');
  switch (style) {
    case 'normal':   return safe;
    case 'bold':     return `<b>${safe}</b>`;
    case 'italic':   return `<i>${safe}</i>`;
    case 'underline':return `<u>${safe}</u>`;
    case 'strike':   return `<s>${safe}</s>`;
    case 'spoiler':  return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code':
    case 'copy':     return `<code>${safe}</code>`;
    case 'pre':      return `<pre>${safe}</pre>`;
    case 'quote':    return `<blockquote>${safe}</blockquote>`;
    case 'heading':  return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets': 
      return (plainText || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'note':     return `📌 <b>Note:</b> ${safe}`;
    case 'warning':  return `⚠️ <b>Warning:</b> ${safe}`;
    case 'success':  return `✅ <b>Success:</b> ${safe}`;
    case 'info':     return `ℹ️ <b>Info:</b> ${safe}`;
    default:         return safe;
  }
}

// ---------- Keyboards ----------
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: '⚡ Quick Mode', callback_data: 'mode_quick' }, { text: '🧱 Multi Mode', callback_data: 'mode_multi' }],
    [{ text: '📝 Post Raw HTML', callback_data: 'tool_raw' }, { text: '🔄 Repost Message', callback_data: 'tool_repost' }],
    [{ text: '😶‍🌫️ Raw Spoiler', callback_data: 'tool_spoiler' }, { text: '❌ Cancel / Reset', callback_data: 'action_reset' }]
  ]
};

const STYLES = [
  { id: 'normal', text: 'Normal 🔤' }, { id: 'bold', text: '𝗕𝗼𝗹𝗱' },
  { id: 'italic', text: '𝙄𝙩𝙖𝙡𝙞𝙘' }, { id: 'underline', text: 'U̲n̲d̲e̲r̲l̲i̲n̲e̲' },
  { id: 'strike', text: 'S̶t̶r̶i̶k̶e̶' }, { id: 'spoiler', text: 'Spoiler 🌫️' },
  { id: 'code', text: '𝙲𝚘𝚍𝚎 (Copy)' }, { id: 'pre', text: 'Block 💻' },
  { id: 'quote', text: '❝ Quote' }, { id: 'heading', text: 'Heading 🔹' },
  { id: 'bullets', text: '• Bullets' }, { id: 'link', text: '🔗 Link' },
  { id: 'note', text: '📌 Note' }, { id: 'warning', text: '⚠️ Warn' },
  { id: 'success', text: '✅ Success' }, { id: 'info', text: 'ℹ️ Info' }
];

function getStyleMenu(session) {
  const keyboard = [];
  // Arrange styles in rows of 2
  for (let i = 0; i < STYLES.length; i += 2) {
    keyboard.push([
      { text: STYLES[i].text, callback_data: `style_${STYLES[i].id}` },
      ...(STYLES[i+1] ? [{ text: STYLES[i+1].text, callback_data: `style_${STYLES[i+1].id}` }] : [])
    ]);
  }
  
  if (session.mode === 'multi') {
    keyboard.push([{ text: `🚀 Publish Draft (${session.draftBlocks.length} Blocks)`, callback_data: 'action_publish' }]);
  }
  keyboard.push([{ text: '🔙 Back to Main Menu', callback_data: 'action_reset' }]);
  
  return { inline_keyboard: keyboard };
}

// ---------- /start Command ----------
bot.onText(/^\/start$/, async (msg) => {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  if (!isOwner(uid)) return bot.sendMessage(chatId, '⛔ Owner only.');

  await cleanPreviousMenu(chatId, uid);
  resetSession(uid);
  
  const text = `👑 <b>Channel Manager Bot</b>\n\nকোন মোডে কাজ করতে চান নির্বাচন করুন:`;
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
  getSession(uid).lastMenuMsgId = sent.message_id;
});

// ---------- Callback Queries (Button Clicks) ----------
bot.on('callback_query', async (query) => {
  const uid = query.from.id;
  const chatId = query.message.chat.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: '⛔ Not allowed.' });

  const data = query.data;
  const session = getSession(uid);

  // Helper to update menu text
  const updateMenu = async (text, markup) => {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: session.lastMenuMsgId, parse_mode: 'HTML', reply_markup: markup });
    } catch (e) {
      await cleanPreviousMenu(chatId, uid);
      const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup });
      session.lastMenuMsgId = sent.message_id;
    }
  };

  if (data === 'action_reset') {
    resetSession(uid);
    await updateMenu(`👑 <b>Channel Manager Bot</b>\n\nমেনু থেকে নির্বাচন করুন:`, MAIN_MENU);
    bot.answerCallbackQuery(query.id);
  } 
  
  else if (data === 'mode_quick') {
    session.mode = 'quick';
    session.state = 'IDLE';
    await updateMenu(`⚡ <b>Quick Mode</b>\nযেকোনো স্টাইল বাটনে ক্লিক করুন:`, getStyleMenu(session));
    bot.answerCallbackQuery(query.id);
  } 
  
  else if (data === 'mode_multi') {
    session.mode = 'multi';
    session.state = 'IDLE';
    await updateMenu(`🧱 <b>Multi Mode</b>\nস্টাইল সিলেক্ট করে ব্লক তৈরি করুন:`, getStyleMenu(session));
    bot.answerCallbackQuery(query.id);
  }

  else if (data.startsWith('style_')) {
    const style = data.replace('style_', '');
    session.selectedStyle = style;
    session.state = 'AWAITING_TEXT';
    
    let hint = 'এখন টেক্সট পাঠান। (মেনুতে ফিরতে Back চাপুন)';
    if (style === 'link') hint = 'ফরম্যাট: <code>শিরোনাম | https://example.com</code>';
    else if (style === 'bullets') hint = 'প্রতিটি পয়েন্ট আলাদা লাইনে লিখুন।';
    else if (style === 'code') hint = 'এই টেক্সটে ট্যাপ করলেই কপি হবে।';

    const modeText = session.mode === 'multi' ? 'Multi Mode Block' : 'Quick Post';
    await updateMenu(`✏️ <b>${modeText}</b>\nস্টাইল: <b>${style}</b>\n\n${hint}`, {
      inline_keyboard: [[{ text: '🔙 Cancel & Back', callback_data: session.mode === 'multi' ? 'mode_multi' : 'mode_quick' }]]
    });
    bot.answerCallbackQuery(query.id);
  }

  else if (data === 'action_publish') {
    if (session.draftBlocks.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ ড্রাফটে কোনো ব্লক নেই!', show_alert: true });
    }
    const html = session.draftBlocks.join('\n\n');
    const replyMarkup = session.draftButtons.length ? { inline_keyboard: session.draftButtons.map(b => [{ text: b.text, url: b.url }]) } : undefined;

    try {
      await bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: replyMarkup });
      resetSession(uid);
      await updateMenu(`✅ <b>Multi-style পোস্ট চ্যানেলে পাঠানো হয়েছে!</b>`, MAIN_MENU);
    } catch (err) {
      bot.answerCallbackQuery(query.id, { text: '❌ পোস্ট ফেইল হয়েছে!', show_alert: true });
    }
  }

  else if (data === 'tool_raw') {
    session.state = 'AWAITING_RAW';
    await updateMenu(`📝 <b>Raw HTML Mode</b>\nআপনার Raw HTML কোডটি মেসেজ হিসেবে পাঠান।`, {
      inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'action_reset' }]]
    });
    bot.answerCallbackQuery(query.id);
  }

  else if (data === 'tool_spoiler') {
    session.state = 'AWAITING_SPOILER';
    await updateMenu(`😶‍🌫️ <b>Raw Spoiler Mode</b>\nআপনার টেক্সট পাঠান, এটি সরাসরি স্পয়লার হিসেবে যাবে।`, {
      inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'action_reset' }]]
    });
    bot.answerCallbackQuery(query.id);
  }

  else if (data === 'tool_repost') {
    session.state = 'AWAITING_REPOST';
    await updateMenu(`🔄 <b>Repost Mode</b>\nযে মেসেজটি চ্যানেলে দিতে চান, সেটি আমাকে ফরওয়ার্ড করুন বা সেন্ড করুন।`, {
      inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'action_reset' }]]
    });
    bot.answerCallbackQuery(query.id);
  }
});

// ---------- Handle Text / Media Inputs ----------
bot.on('message', async (msg) => {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  if (!isOwner(uid)) return;
  if (msg.text && msg.text.startsWith('/')) return; // Ignore /start

  const session = getSession(uid);
  
  // Clean user's command message conceptually (Bots can't delete user PMs, so we refresh bot's menu below)
  await cleanPreviousMenu(chatId, uid);

  // 1. REPOST MODE
  if (session.state === 'AWAITING_REPOST') {
    try {
      await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      resetSession(uid);
      const sent = await bot.sendMessage(chatId, `✅ <b>মেসেজ চ্যানেলে কপি করা হয়েছে!</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
      session.lastMenuMsgId = sent.message_id;
    } catch (err) {
      const sent = await bot.sendMessage(chatId, `❌ <b>কপি করতে সমস্যা হয়েছে।</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
      session.lastMenuMsgId = sent.message_id;
    }
    return;
  }

  // Text is required for the rest
  const fullText = msg.text || '';
  if (!fullText) {
    const sent = await bot.sendMessage(chatId, '⚠️ অনুগ্রহ করে টেক্সট পাঠান।', { reply_markup: MAIN_MENU });
    session.lastMenuMsgId = sent.message_id;
    return;
  }

  const { textOnly, buttons } = parseButtonsBlock(fullText);
  const plainText = textOnly.trim();

  // 2. RAW HTML MODE
  if (session.state === 'AWAITING_RAW') {
    const rm = buttons.length ? { inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]) } : undefined;
    try {
      await bot.sendMessage(CHANNEL_ID, plainText, { parse_mode: 'HTML', reply_markup: rm });
      resetSession(uid);
      const sent = await bot.sendMessage(chatId, `✅ <b>HTML পোস্ট সম্পন্ন!</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
      session.lastMenuMsgId = sent.message_id;
    } catch (e) {
      const sent = await bot.sendMessage(chatId, `❌ <b>HTML ফেইল হয়েছে। ট্যাগ চেক করুন।</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
      session.lastMenuMsgId = sent.message_id;
    }
    return;
  }

  // 3. RAW SPOILER MODE
  if (session.state === 'AWAITING_SPOILER') {
    try {
      await bot.sendMessage(CHANNEL_ID, `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`, { parse_mode: 'HTML' });
      resetSession(uid);
      const sent = await bot.sendMessage(chatId, `✅ <b>Spoiler পোস্ট সম্পন্ন!</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
      session.lastMenuMsgId = sent.message_id;
    } catch (e) {
      const sent = await bot.sendMessage(chatId, `❌ <b>ফেইল হয়েছে।</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
      session.lastMenuMsgId = sent.message_id;
    }
    return;
  }

  // 4. STYLE MODES (Quick / Multi)
  if (session.state === 'AWAITING_TEXT') {
    let htmlBlock;
    if (session.selectedStyle === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (!parts[0] || !parts[1]) {
        const sent = await bot.sendMessage(chatId, '⚠️ Link ফরম্যাট ভুল। Title | URL দিন।', { reply_markup: getStyleMenu(session) });
        session.lastMenuMsgId = sent.message_id;
        return;
      }
      let url = parts[1];
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      htmlBlock = `<a href="${escapeHtml(url)}">${escapeHtml(parts[0])}</a>`;
    } else {
      htmlBlock = buildStyledHtml(session.selectedStyle, plainText);
    }

    if (session.mode === 'multi') {
      session.draftBlocks.push(htmlBlock);
      if (buttons.length) session.draftButtons = buttons; // Keep latest buttons
      session.state = 'IDLE';
      
      const sent = await bot.sendMessage(chatId, `🧱 <b>Block #${session.draftBlocks.length} যোগ হয়েছে!</b>\nআরও স্টাইল সিলেক্ট করুন বা Publish করুন।`, { parse_mode: 'HTML', reply_markup: getStyleMenu(session) });
      session.lastMenuMsgId = sent.message_id;
    } 
    
    else if (session.mode === 'quick') {
      const rm = buttons.length ? { inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]) } : undefined;
      try {
        await bot.sendMessage(CHANNEL_ID, htmlBlock, { parse_mode: 'HTML', reply_markup: rm });
        resetSession(uid);
        const sent = await bot.sendMessage(chatId, `✅ <b>চ্যানেলে পোস্ট হয়েছে!</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
        session.lastMenuMsgId = sent.message_id;
      } catch (e) {
        const sent = await bot.sendMessage(chatId, `❌ <b>পোস্ট ফেইল হয়েছে।</b>`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
        session.lastMenuMsgId = sent.message_id;
      }
    }
    return;
  }

  // If IDLE, just show main menu
  const sent = await bot.sendMessage(chatId, `👑 <b>Channel Manager Bot</b>\n\nকী করতে চান নির্বাচন করুন:`, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
  session.lastMenuMsgId = sent.message_id;
});
