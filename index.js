// Clean & Professional Channel Manager Bot
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
app.get('/', (_req, res) => res.send('✅ Professional Channel Manager Bot is running.'));
app.listen(PORT, () => console.log('🌐 Server on port', PORT));

// ---------- Telegram bot ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 Professional Bot started');

// ---------- Session Management ----------
const sessions = {};

function getSession(uid) {
  if (!sessions[uid]) {
    sessions[uid] = {
      state: 'IDLE',
      mode: null,
      selectedStyle: null,
      draftBlocks: [],
      draftButtons: [],
      lastMenuMsgId: null,
      messagesToClean: [] // ইউজারের মেসেজ মুছে ফেলার জন্য
    };
  }
  return sessions[uid];
}

function resetSession(uid) {
  const session = getSession(uid);
  session.state = 'IDLE';
  session.mode = null;
  session.selectedStyle = null;
  session.draftBlocks = [];
  session.draftButtons = [];
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

// চ্যাট স্ক্রিন পরিষ্কার করার ফাংশন
async function cleanUserMessages(chatId, uid) {
  const session = getSession(uid);
  if (session.messagesToClean.length > 0) {
    for (const msgId of session.messagesToClean) {
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (e) { /* Ignore */ }
    }
    session.messagesToClean = []; // Reset after clean
  }
}

// বটের মেনু আপডেট করার গ্লোবাল ফাংশন
async function renderMenu(chatId, uid, text, markup) {
  const session = getSession(uid);
  try {
    if (session.lastMenuMsgId) {
      await bot.editMessageText(text, { 
        chat_id: chatId, 
        message_id: session.lastMenuMsgId, 
        parse_mode: 'HTML', 
        reply_markup: markup,
        disable_web_page_preview: true
      });
    } else {
      throw new Error('No Menu ID');
    }
  } catch (e) {
    // আগের মেনু মুছে নতুন করে পাঠাবে
    try { await bot.deleteMessage(chatId, session.lastMenuMsgId); } catch(err){}
    const sent = await bot.sendMessage(chatId, text, { 
      parse_mode: 'HTML', 
      reply_markup: markup,
      disable_web_page_preview: true 
    });
    session.lastMenuMsgId = sent.message_id;
  }
}

// ---------- Styled HTML Builder ----------
function buildStyledHtml(style, plainText) {
  const safe = escapeHtml(plainText || '');
  const lines = (plainText || '').split('\n').map(l => l.trim()).filter(Boolean);
  
  switch (style) {
    case 'normal':   return safe;
    case 'title':    return `🏆 <b>${safe.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━━━`;
    case 'bold':     return `<b>${safe}</b>`;
    case 'italic':   return `<i>${safe}</i>`;
    case 'underline':return `<u>${safe}</u>`;
    case 'strike':   return `<s>${safe}</s>`;
    case 'spoiler':  return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'highlight':return `🌟 <b><i>${safe}</i></b>`;
    case 'code':     return `<code>${safe}</code>`;
    case 'pre':      return `<pre>${safe}</pre>`;
    case 'terminal': return `<pre>>_ ${safe}</pre>`;
    case 'quote':    return `<blockquote>${safe}</blockquote>`;
    case 'heading':  return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets':  return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'numbered': return lines.map((l, i) => `${i+1}. ${escapeHtml(l)}`).join('\n');
    case 'pros':     return lines.map(l => `✅ ${escapeHtml(l)}`).join('\n');
    case 'cons':     return lines.map(l => `❌ ${escapeHtml(l)}`).join('\n');
    case 'note':     return `📌 <b>Note:</b> ${safe}`;
    case 'warning':  return `⚠️ <b>Warning:</b> ${safe}`;
    case 'signature':return `\n<i>— ${safe}</i>`;
    default:         return safe;
  }
}

// ---------- Keyboards ----------
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: '⚡ Quick Mode', callback_data: 'mode_quick' }, { text: '🧱 Multi Mode', callback_data: 'mode_multi' }],
    [{ text: '📝 Post Raw HTML', callback_data: 'tool_raw' }, { text: '🔄 Repost Message', callback_data: 'tool_repost' }],
    [{ text: '😶‍🌫️ Raw Spoiler', callback_data: 'tool_spoiler' }, { text: '❌ Reset Bot', callback_data: 'action_reset' }]
  ]
};

// Expanded Styles Array
const STYLES = [
  { id: 'normal', text: 'Normal 🔤' },     { id: 'title', text: '🏆 Title' },
  { id: 'bold', text: '𝗕𝗼𝗹𝗱' },            { id: 'heading', text: '🔹 Heading' },
  { id: 'italic', text: '𝙄𝙩𝙖𝙡𝙞𝙘' },        { id: 'highlight', text: '🌟 Highlight' },
  { id: 'underline', text: 'U̲n̲d̲e̲r̲l̲i̲n̲e̲' },   { id: 'bullets', text: '• Bullets' },
  { id: 'strike', text: 'S̶t̶r̶i̶k̶e̶' },        { id: 'numbered', text: '1️⃣ Numbered' },
  { id: 'spoiler', text: 'Spoiler 🌫️' },   { id: 'pros', text: '✅ Pros' },
  { id: 'quote', text: '❝ Quote' },        { id: 'cons', text: '❌ Cons' },
  { id: 'code', text: '𝙲𝚘𝚍𝚎 (Copy)' },     { id: 'terminal', text: '⌨️ Terminal' },
  { id: 'pre', text: 'Block 💻' },         { id: 'link', text: '🔗 Link' },
  { id: 'note', text: '📌 Note' },         { id: 'warning', text: '⚠️ Warn' },
  { id: 'signature', text: '✍️ Signature' }
];

function getStyleMenu(session) {
  const keyboard = [];
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

// ---------- Commands ----------
bot.onText(/^\/start$/, async (msg) => {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  if (!isOwner(uid)) return;

  // Track the /start message to delete it
  const session = getSession(uid);
  session.messagesToClean.push(msg.message_id);
  await cleanUserMessages(chatId, uid);

  resetSession(uid);
  
  const text = `👑 <b>Channel Manager Pro</b>\n\nস্বাগতম! চ্যাট সম্পূর্ণ ক্লিন থাকবে।\nকোন মোডে কাজ করতে চান নির্বাচন করুন:`;
  
  // Send fresh menu
  try { await bot.deleteMessage(chatId, session.lastMenuMsgId); } catch(e){}
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
  session.lastMenuMsgId = sent.message_id;
});

// ---------- Callback Queries ----------
bot.on('callback_query', async (query) => {
  const uid = query.from.id;
  const chatId = query.message.chat.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: '⛔ Access Denied' });

  const data = query.data;
  const session = getSession(uid);

  if (data === 'action_reset') {
    resetSession(uid);
    await renderMenu(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\nমেনু থেকে নির্বাচন করুন:`, MAIN_MENU);
    bot.answerCallbackQuery(query.id);
  } 
  
  else if (data === 'mode_quick') {
    session.mode = 'quick';
    session.state = 'IDLE';
    await renderMenu(chatId, uid, `⚡ <b>Quick Mode</b>\nযে কোনো স্টাইল বাটনে ক্লিক করুন:`, getStyleMenu(session));
    bot.answerCallbackQuery(query.id);
  } 
  
  else if (data === 'mode_multi') {
    session.mode = 'multi';
    session.state = 'IDLE';
    await renderMenu(chatId, uid, `🧱 <b>Multi Mode</b>\nস্টাইল সিলেক্ট করে ব্লক তৈরি করুন:`, getStyleMenu(session));
    bot.answerCallbackQuery(query.id);
  }

  else if (data.startsWith('style_')) {
    const style = data.replace('style_', '');
    session.selectedStyle = style;
    session.state = 'AWAITING_TEXT';
    
    let hint = 'এখন আপনার টেক্সট পাঠান...';
    if (style === 'link') hint = 'ফরম্যাট: <code>শিরোনাম | https://example.com</code>';
    else if (['bullets', 'numbered', 'pros', 'cons'].includes(style)) hint = 'প্রতিটি পয়েন্ট আলাদা লাইনে লিখুন।';
    
    const modeText = session.mode === 'multi' ? 'Multi Mode Block' : 'Quick Post';
    await renderMenu(chatId, uid, `✏️ <b>${modeText}</b>\nস্টাইল: <b>${style.toUpperCase()}</b>\n\n${hint}`, {
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
      await bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      resetSession(uid);
      await renderMenu(chatId, uid, `✅ <b>Multi-style পোস্ট চ্যানেলে পাঠানো হয়েছে!</b>`, MAIN_MENU);
      bot.answerCallbackQuery(query.id);
    } catch (err) {
      bot.answerCallbackQuery(query.id, { text: '❌ পোস্ট ফেইল হয়েছে!', show_alert: true });
    }
  }

  else if (data === 'tool_raw') {
    session.state = 'AWAITING_RAW';
    await renderMenu(chatId, uid, `📝 <b>Raw HTML Mode</b>\nআপনার Raw HTML কোডটি মেসেজ হিসেবে পাঠান।`, {
      inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'action_reset' }]]
    });
    bot.answerCallbackQuery(query.id);
  }

  else if (data === 'tool_spoiler') {
    session.state = 'AWAITING_SPOILER';
    await renderMenu(chatId, uid, `😶‍🌫️ <b>Raw Spoiler Mode</b>\nআপনার টেক্সট পাঠান, এটি সরাসরি স্পয়লার হিসেবে যাবে।`, {
      inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'action_reset' }]]
    });
    bot.answerCallbackQuery(query.id);
  }

  else if (data === 'tool_repost') {
    session.state = 'AWAITING_REPOST';
    await renderMenu(chatId, uid, `🔄 <b>Repost Mode</b>\nযে মেসেজটি চ্যানেলে দিতে চান, সেটি আমাকে ফরওয়ার্ড করুন বা সেন্ড করুন।`, {
      inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'action_reset' }]]
    });
    bot.answerCallbackQuery(query.id);
  }
});

// ---------- Handle User Messages ----------
bot.on('message', async (msg) => {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  if (!isOwner(uid)) return;
  if (msg.text && msg.text.startsWith('/')) return; // Ignore commands here

  const session = getSession(uid);
  
  // ১. ইউজারের মেসেজ ট্র্যাক করা হলো মুছে ফেলার জন্য
  session.messagesToClean.push(msg.message_id);

  // ২. REPOST MODE
  if (session.state === 'AWAITING_REPOST') {
    try {
      await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      await cleanUserMessages(chatId, uid); // ইউজারের মেসেজ ডিলিট
      resetSession(uid);
      await renderMenu(chatId, uid, `✅ <b>মেসেজ চ্যানেলে কপি করা হয়েছে!</b>`, MAIN_MENU);
    } catch (err) {
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `❌ <b>কপি করতে সমস্যা হয়েছে।</b>`, MAIN_MENU);
    }
    return;
  }

  // ৩. বাকি কাজের জন্য টেক্সট আবশ্যক
  const fullText = msg.text || '';
  if (!fullText) {
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, '⚠️ অনুগ্রহ করে টেক্সট পাঠান।', MAIN_MENU);
    return;
  }

  const { textOnly, buttons } = parseButtonsBlock(fullText);
  const plainText = textOnly.trim();

  // ৪. RAW HTML / SPOILER MODES
  if (session.state === 'AWAITING_RAW' || session.state === 'AWAITING_SPOILER') {
    let finalHtml = plainText;
    if (session.state === 'AWAITING_SPOILER') {
      finalHtml = `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`;
    }
    
    const rm = buttons.length ? { inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]) } : undefined;
    try {
      await bot.sendMessage(CHANNEL_ID, finalHtml, { parse_mode: 'HTML', reply_markup: rm, disable_web_page_preview: true });
      await cleanUserMessages(chatId, uid); // Clean User input
      resetSession(uid);
      await renderMenu(chatId, uid, `✅ <b>সফলভাবে চ্যানেলে পোস্ট হয়েছে!</b>`, MAIN_MENU);
    } catch (e) {
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `❌ <b>পোস্ট ফেইল হয়েছে। ট্যাগ চেক করুন।</b>`, MAIN_MENU);
    }
    return;
  }

  // ৫. STYLE MODES (Quick / Multi)
  if (session.state === 'AWAITING_TEXT') {
    let htmlBlock;
    if (session.selectedStyle === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (!parts[0] || !parts[1]) {
        await cleanUserMessages(chatId, uid);
        await renderMenu(chatId, uid, '⚠️ Link ফরম্যাট ভুল। <code>Title | URL</code> দিন।', getStyleMenu(session));
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
      if (buttons.length) session.draftButtons = buttons;
      session.state = 'IDLE';
      
      await cleanUserMessages(chatId, uid); // Clean user input
      await renderMenu(chatId, uid, `🧱 <b>Block #${session.draftBlocks.length} যোগ হয়েছে!</b>\nআরও স্টাইল সিলেক্ট করুন বা Publish করুন।`, getStyleMenu(session));
    } 
    
    else if (session.mode === 'quick') {
      const rm = buttons.length ? { inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]) } : undefined;
      try {
        await bot.sendMessage(CHANNEL_ID, htmlBlock, { parse_mode: 'HTML', reply_markup: rm, disable_web_page_preview: true });
        await cleanUserMessages(chatId, uid); // Clean user input
        resetSession(uid);
        await renderMenu(chatId, uid, `✅ <b>চ্যানেলে পোস্ট হয়েছে!</b>`, MAIN_MENU);
      } catch (e) {
        await cleanUserMessages(chatId, uid);
        await renderMenu(chatId, uid, `❌ <b>পোস্ট ফেইল হয়েছে।</b>`, MAIN_MENU);
      }
    }
    return;
  }

  // If somehow IDLE but typed text, just clean it and show menu
  await cleanUserMessages(chatId, uid);
  await renderMenu(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\nকী করতে চান নির্বাচন করুন:`, MAIN_MENU);
});
