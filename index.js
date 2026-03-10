// 👑 Pro Channel Manager Bot - Advanced Edition
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
app.get('/', (_req, res) => res.send('✅ Pro Channel Manager is running.'));
app.listen(PORT, () => console.log('🌐 Server on port', PORT));

// ---------- Telegram bot ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// মেনু বাটন (নীল রঙের) রিমুভ করার জন্য
bot.setMyCommands([]); 
console.log('🤖 Pro Bot started');

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
      mediaType: null, // 'photo' or 'video'
      mediaId: null,
      lastMenuMsgId: null,
      messagesToClean: []
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
  session.mediaType = null;
  session.mediaId = null;
}

// ---------- Helpers ----------
function isOwner(id) {
  return id === OWNER_ID;
}

function escapeHtml(t) {
  if (!t) return '';
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// উন্নত বাটন পার্সিং (এক লাইনে একাধিক বাটন: Name | Link || Name2 | Link2)
function parseButtonsBlock(text) {
  if (!text) return { textOnly: text, buttons: [] };
  const idx = text.lastIndexOf('BUTTONS:');
  if (idx === -1) return { textOnly: text, buttons: [] };
  
  const before = text.slice(0, idx).trim();
  const block = text.slice(idx + 'BUTTONS:'.length).trim();
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  
  const buttons = [];
  for (const line of lines) {
    const rowButtons = line.split('||').map(b => b.trim());
    const row = [];
    for (const btn of rowButtons) {
      const parts = btn.split('|').map(p => p.trim());
      if (parts.length >= 2 && /^https?:\/\//i.test(parts[1])) {
        row.push({ text: parts[0], url: parts[1] });
      }
    }
    if (row.length > 0) buttons.push(row);
  }
  return { textOnly: before, buttons };
}

async function cleanUserMessages(chatId, uid) {
  const session = getSession(uid);
  if (session.messagesToClean.length > 0) {
    for (const msgId of session.messagesToClean) {
      try { await bot.deleteMessage(chatId, msgId); } catch (e) { /* Ignore */ }
    }
    session.messagesToClean = []; 
  }
}

async function renderMenu(chatId, uid, text, markup) {
  const session = getSession(uid);
  try {
    if (session.lastMenuMsgId) {
      await bot.editMessageText(text, { 
        chat_id: chatId, message_id: session.lastMenuMsgId, 
        parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true
      });
    } else { throw new Error('No Menu ID'); }
  } catch (e) {
    try { await bot.deleteMessage(chatId, session.lastMenuMsgId); } catch(err){}
    const sent = await bot.sendMessage(chatId, text, { 
      parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true 
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
    case 'quote':    return `<blockquote>${safe}</blockquote>`;
    case 'expand_quote': return `<blockquote expandable>${safe}</blockquote>`;
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
// ১. ফোর ডট মেনু (Reply Keyboard - ইনপুটের নিচে থাকবে)
const REPLY_MAIN_MENU = {
  keyboard: [
    [{ text: '⚡ Quick Mode' }, { text: '🧱 Multi Mode' }],
    [{ text: '🖼️ Media Post' }, { text: '📝 Raw HTML' }],
    [{ text: '🔄 Repost Msg' }, { text: '😶‍🌫️ Spoiler' }],
    [{ text: '❌ Reset Bot' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

// ২. ইনলাইন কীবোর্ড (স্টাইল সিলেক্ট করার জন্য)
const STYLES = [
  { id: 'normal', text: 'Normal 🔤' },     { id: 'title', text: '🏆 Title' },
  { id: 'bold', text: '𝗕𝗼𝗹𝗱' },            { id: 'heading', text: '🔹 Heading' },
  { id: 'italic', text: '𝙄𝙩𝙖𝙡𝙞𝙘' },        { id: 'highlight', text: '🌟 Highlight' },
  { id: 'spoiler', text: 'Spoiler 🌫️' },   { id: 'quote', text: '❝ Quote' },
  { id: 'expand_quote', text: '📖 Exp. Quote' }, { id: 'code', text: '𝙲𝚘𝚍𝚎 (Copy)' },
  { id: 'bullets', text: '• Bullets' },    { id: 'numbered', text: '1️⃣ Numbered' },
  { id: 'pros', text: '✅ Pros' },         { id: 'cons', text: '❌ Cons' },
  { id: 'link', text: '🔗 Link' },         { id: 'signature', text: '✍️ Signature' }
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
  return { inline_keyboard: keyboard };
}

// ---------- System / Commands ----------
async function sendWelcome(chatId, uid) {
  const session = getSession(uid);
  const text = `👑 <b>Channel Manager Pro</b>\n\nস্বাগতম! নিচের <b>Four-dot মেনু (🎛️)</b> থেকে আপনার প্রয়োজনীয় মোডটি সিলেক্ট করুন।\n\n<i>আপনার চ্যাট সর্বদা ক্লিন রাখা হবে।</i>`;
  try { await bot.deleteMessage(chatId, session.lastMenuMsgId); } catch(e){}
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: REPLY_MAIN_MENU });
  session.lastMenuMsgId = sent.message_id;
}

bot.onText(/^\/start$/, async (msg) => {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  if (!isOwner(uid)) return;

  const session = getSession(uid);
  session.messagesToClean.push(msg.message_id);
  await cleanUserMessages(chatId, uid);
  resetSession(uid);
  await sendWelcome(chatId, uid);
});

// ---------- Message Handler (Main Logic) ----------
bot.on('message', async (msg) => {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  if (!isOwner(uid)) return;
  if (msg.text && msg.text.startsWith('/')) return;

  const session = getSession(uid);
  session.messagesToClean.push(msg.message_id); // চ্যাট ক্লিন করার জন্য ট্র্যাক

  const text = msg.text || '';

  // === Reply Keyboard Menu Interception ===
  if (text === '❌ Reset Bot') {
    await cleanUserMessages(chatId, uid);
    resetSession(uid);
    await sendWelcome(chatId, uid);
    return;
  }
  if (text === '⚡ Quick Mode') {
    resetSession(uid);
    session.mode = 'quick';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `⚡ <b>Quick Mode</b>\nটেক্সট এর জন্য একটি স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }
  if (text === '🧱 Multi Mode') {
    resetSession(uid);
    session.mode = 'multi';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `🧱 <b>Multi Mode</b>\nস্টাইল সিলেক্ট করে ব্লক তৈরি করুন:`, getStyleMenu(session));
    return;
  }
  if (text === '🖼️ Media Post') {
    resetSession(uid);
    session.state = 'AWAITING_MEDIA';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `🖼️ <b>Media Mode</b>\nযে ছবি বা ভিডিওটি পোস্ট করতে চান সেটি পাঠান।`, { inline_keyboard: [] });
    return;
  }
  if (text === '📝 Raw HTML') {
    resetSession(uid);
    session.state = 'AWAITING_RAW';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `📝 <b>Raw HTML Mode</b>\nআপনার Raw HTML কোডটি মেসেজ হিসেবে পাঠান।`, { inline_keyboard: [] });
    return;
  }
  if (text === '😶‍🌫️ Spoiler') {
    resetSession(uid);
    session.state = 'AWAITING_SPOILER';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `😶‍🌫️ <b>Raw Spoiler Mode</b>\nটেক্সট পাঠান, সরাসরি স্পয়লার হিসেবে চ্যানেলে যাবে।`, { inline_keyboard: [] });
    return;
  }
  if (text === '🔄 Repost Msg') {
    resetSession(uid);
    session.state = 'AWAITING_REPOST';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `🔄 <b>Repost Mode</b>\nযে মেসেজটি চ্যানেলে দিতে চান, সেটি আমাকে ফরওয়ার্ড করুন বা সেন্ড করুন।`, { inline_keyboard: [] });
    return;
  }

  // === Processing States ===

  // 1. REPOST
  if (session.state === 'AWAITING_REPOST') {
    try {
      await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      await cleanUserMessages(chatId, uid); 
      resetSession(uid);
      await sendWelcome(chatId, uid);
    } catch (err) {
      await renderMenu(chatId, uid, `❌ <b>কপি করতে সমস্যা হয়েছে।</b>`, { inline_keyboard: [] });
    }
    return;
  }

  // 2. MEDIA UPLOAD
  if (session.state === 'AWAITING_MEDIA') {
    if (msg.photo) {
      session.mediaId = msg.photo[msg.photo.length - 1].file_id;
      session.mediaType = 'photo';
    } else if (msg.video) {
      session.mediaId = msg.video.file_id;
      session.mediaType = 'video';
    } else {
      await renderMenu(chatId, uid, '⚠️ অনুগ্রহ করে একটি ছবি বা ভিডিও পাঠান।', { inline_keyboard: [] });
      return;
    }
    
    session.mode = 'media_caption';
    session.state = 'IDLE';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `✅ <b>মিডিয়া রিসিভ হয়েছে!</b>\nক্যাপশনের জন্য স্টাইল সিলেক্ট করুন (বাটন যোগ করতে পারবেন):`, getStyleMenu(session));
    return;
  }

  // Text required for below states
  if (!text) {
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, '⚠️ অনুগ্রহ করে টেক্সট পাঠান।', { inline_keyboard: [] });
    return;
  }

  const { textOnly, buttons } = parseButtonsBlock(text);
  const plainText = textOnly.trim();
  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;

  // 3. RAW HTML / SPOILER
  if (session.state === 'AWAITING_RAW' || session.state === 'AWAITING_SPOILER') {
    let finalHtml = plainText;
    if (session.state === 'AWAITING_SPOILER') {
      finalHtml = `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`;
    }
    try {
      await bot.sendMessage(CHANNEL_ID, finalHtml, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      await cleanUserMessages(chatId, uid); 
      resetSession(uid);
      await sendWelcome(chatId, uid);
    } catch (e) {
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `❌ <b>পোস্ট ফেইল হয়েছে। HTML ট্যাগ চেক করুন।</b>`, { inline_keyboard: [] });
    }
    return;
  }

  // 4. TEXT PROCESSING (Quick, Multi, Media Caption)
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
      if (buttons.length) session.draftButtons = buttons; // Keep last buttons
      session.state = 'IDLE';
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `🧱 <b>Block #${session.draftBlocks.length} যোগ হয়েছে!</b>\nআরও স্টাইল সিলেক্ট করুন বা Publish করুন।`, getStyleMenu(session));
    } 
    else if (session.mode === 'quick') {
      try {
        await bot.sendMessage(CHANNEL_ID, htmlBlock, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
        await cleanUserMessages(chatId, uid);
        resetSession(uid);
        await sendWelcome(chatId, uid);
      } catch (e) {
        await cleanUserMessages(chatId, uid);
        await renderMenu(chatId, uid, `❌ <b>পোস্ট ফেইল হয়েছে।</b>`, { inline_keyboard: [] });
      }
    }
    else if (session.mode === 'media_caption') {
      try {
        const opts = { caption: htmlBlock, parse_mode: 'HTML', reply_markup: replyMarkup };
        if (session.mediaType === 'photo') {
          await bot.sendPhoto(CHANNEL_ID, session.mediaId, opts);
        } else {
          await bot.sendVideo(CHANNEL_ID, session.mediaId, opts);
        }
        await cleanUserMessages(chatId, uid);
        resetSession(uid);
        await sendWelcome(chatId, uid);
      } catch (e) {
        await cleanUserMessages(chatId, uid);
        await renderMenu(chatId, uid, `❌ <b>মিডিয়া পোস্ট ফেইল হয়েছে।</b>`, { inline_keyboard: [] });
      }
    }
    return;
  }

  // Fallback
  await cleanUserMessages(chatId, uid);
});

// ---------- Inline Button Handler ----------
bot.on('callback_query', async (query) => {
  const uid = query.from.id;
  const chatId = query.message.chat.id;
  if (!isOwner(uid)) return bot.answerCallbackQuery(query.id, { text: '⛔ Access Denied' });

  const data = query.data;
  const session = getSession(uid);

  if (data.startsWith('style_')) {
    const style = data.replace('style_', '');
    session.selectedStyle = style;
    session.state = 'AWAITING_TEXT';
    
    let hint = 'এখন আপনার টেক্সট পাঠান... (বাটন দিতে চাইলে শেষে BUTTONS: দিয়ে লিখুন)';
    if (style === 'link') hint = 'ফরম্যাট: <code>শিরোনাম | https://example.com</code>';
    else if (['bullets', 'numbered', 'pros', 'cons'].includes(style)) hint = 'প্রতিটি পয়েন্ট আলাদা লাইনে লিখুন।';
    
    await renderMenu(chatId, uid, `✏️ <b>Draft Editor</b>\nস্টাইল: <b>${style.toUpperCase()}</b>\n\n${hint}`, { inline_keyboard: [] });
    bot.answerCallbackQuery(query.id);
  }

  else if (data === 'action_publish') {
    if (session.draftBlocks.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ ড্রাফটে কোনো ব্লক নেই!', show_alert: true });
    }
    const html = session.draftBlocks.join('\n\n');
    const replyMarkup = session.draftButtons.length ? { inline_keyboard: session.draftButtons } : undefined;

    try {
      await bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      resetSession(uid);
      await sendWelcome(chatId, uid);
      bot.answerCallbackQuery(query.id, { text: '✅ পাবলিশ সম্পন্ন!' });
    } catch (err) {
      bot.answerCallbackQuery(query.id, { text: '❌ পোস্ট ফেইল হয়েছে! টেক্সট অনেক বড় বা ট্যাগ ভুল।', show_alert: true });
    }
  }
});
