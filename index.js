require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;       
const OWNER_ID = Number(process.env.OWNER_ID);   
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID || !OWNER_ID) {
  console.error("Missing Environment Variables! Check .env file.");
  process.exit(1);
}

// Express Server for keep-alive (e.g., Replit, Render)
const app = express();
app.get('/', (_req, res) => res.send('Channel Manager Pro Bot is running smoothly.'));
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// Initialize Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Setup Bot Commands Menu
bot.setMyCommands([{ command: '/start', description: 'Start the bot / Main Menu' }]);

// Session Management
const sessions = {};

function getSession(uid) {
  if (!sessions[uid]) {
    sessions[uid] = {
      state: 'IDLE',
      mode: null,
      selectedStyle: null,
      draftBlocks: [],
      draftButtons: [],
      mediaType: null,
      mediaId: null,
      lastMenuMsgId: null
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

// Utility: HTML Escaper
function escapeHtml(t) {
  if (!t) return '';
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Utility: Delete Message Silently
async function safeDelete(chatId, msgId) {
  try { await bot.deleteMessage(chatId, msgId); } catch (e) { /* Ignore */ }
}

// Utility: Parse Buttons Custom Format
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

// Menus (Using Inline Keyboards for a Clean UI)
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: '⚡ Quick Mode', callback_data: 'm_quick' }, { text: '🧱 Multi Mode', callback_data: 'm_multi' }],
    [{ text: '🖼️ Media Post', callback_data: 'm_media' }, { text: '📝 Raw HTML', callback_data: 'm_html' }],
    [{ text: '🔄 Repost Msg', callback_data: 'm_repost' }, { text: '😶‍🌫️ Spoiler', callback_data: 'm_spoiler' }],
    [{ text: '❌ Reset Bot', callback_data: 'reset' }]
  ]
};

const CANCEL_MENU = {
  inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'cancel' }]]
};

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
      { text: STYLES[i].text, callback_data: `s_${STYLES[i].id}` },
      ...(STYLES[i+1] ? [{ text: STYLES[i+1].text, callback_data: `s_${STYLES[i+1].id}` }] : [])
    ]);
  }
  if (session.mode === 'multi') {
    keyboard.push([{ text: `🚀 Publish Draft (${session.draftBlocks.length} Blocks)`, callback_data: 'publish' }]);
  }
  keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'cancel' }]);
  return { inline_keyboard: keyboard };
}

// HTML Builder
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

// UI Updater (Edits single message instead of spamming)
async function updateMenu(chatId, uid, text, markup) {
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
      const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });
      session.lastMenuMsgId = sent.message_id;
    }
  } catch (err) {
    // If message was deleted or old, send a new one
    const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });
    session.lastMenuMsgId = sent.message_id;
  }
}

// Command: /start
bot.onText(/^\/start$/, async (msg) => {
  const uid = msg.from.id;
  if (uid !== OWNER_ID) return;
  const chatId = msg.chat.id;
  
  await safeDelete(chatId, msg.message_id); // Delete user's /start
  resetSession(uid);
  
  // Force delete old menu if user types /start manually
  const session = getSession(uid);
  if(session.lastMenuMsgId) await safeDelete(chatId, session.lastMenuMsgId);
  session.lastMenuMsgId = null;

  await updateMenu(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\nস্বাগতম! নিচের মেনু থেকে অপশন নির্বাচন করুন:`, MAIN_MENU);
});

// Handle Button Clicks (Inline Keyboard Responses)
bot.on('callback_query', async (query) => {
  const uid = query.from.id;
  if (uid !== OWNER_ID) return bot.answerCallbackQuery(query.id, { text: "Not Authorized", show_alert: true });
  
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(uid);

  // Always answer callback to remove loading state
  bot.answerCallbackQuery(query.id).catch(()=>{});

  if (data === 'reset' || data === 'cancel') {
    resetSession(uid);
    await updateMenu(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\nঅপারেশন বাতিল করা হয়েছে। নতুন অপশন নির্বাচন করুন:`, MAIN_MENU);
    return;
  }

  if (data === 'm_quick') {
    session.mode = 'quick'; session.state = 'IDLE';
    await updateMenu(chatId, uid, `⚡ <b>Quick Mode</b>\nটেক্সট পোস্ট করার স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }
  if (data === 'm_multi') {
    session.mode = 'multi'; session.state = 'IDLE';
    await updateMenu(chatId, uid, `🧱 <b>Multi Mode</b>\nস্টাইল সিলেক্ট করে ব্লক তৈরি করুন:`, getStyleMenu(session));
    return;
  }
  if (data === 'm_media') {
    session.state = 'AWAITING_MEDIA';
    await updateMenu(chatId, uid, `🖼️ <b>Media Mode</b>\nআপনার ছবি বা ভিডিওটি ফরওয়ার্ড বা সেন্ড করুন।`, CANCEL_MENU);
    return;
  }
  if (data === 'm_html') {
    session.state = 'AWAITING_RAW';
    await updateMenu(chatId, uid, `📝 <b>Raw HTML</b>\nসরাসরি HTML কোড পাঠান।`, CANCEL_MENU);
    return;
  }
  if (data === 'm_repost') {
    session.state = 'AWAITING_REPOST';
    await updateMenu(chatId, uid, `🔄 <b>Repost Mode</b>\nযেকোনো মেসেজ ফরওয়ার্ড বা সেন্ড করুন।`, CANCEL_MENU);
    return;
  }
  if (data === 'm_spoiler') {
    session.state = 'AWAITING_SPOILER';
    await updateMenu(chatId, uid, `😶‍🌫️ <b>Raw Spoiler</b>\nটেক্সট পাঠান, যা চ্যানেলে হাইড অবস্থায় থাকবে।`, CANCEL_MENU);
    return;
  }

  // Handle Publish
  if (data === 'publish') {
    if (session.draftBlocks.length === 0) {
      await updateMenu(chatId, uid, `⚠️ <b>Empty draft!</b> কোনো ব্লক নেই।`, getStyleMenu(session));
      return;
    }
    const html = session.draftBlocks.join('\n\n');
    const replyMarkup = session.draftButtons.length ? { inline_keyboard: session.draftButtons } : undefined;
    try {
      await bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      resetSession(uid);
      await updateMenu(chatId, uid, `✅ <b>সফলভাবে চ্যানেলে পোস্ট হয়েছে!</b>\n\nনতুন কিছু পোস্ট করতে চাইলে সিলেক্ট করুন:`, MAIN_MENU);
    } catch (err) {
      await updateMenu(chatId, uid, `❌ <b>Error!</b> চ্যানেলে পোস্ট করতে ব্যর্থ হয়েছে। HTML বা Bot Admin Right চেক করুন।`, getStyleMenu(session));
    }
    return;
  }

  // Handle Style Selection
  if (data.startsWith('s_')) {
    const styleId = data.replace('s_', '');
    const selectedStyleObj = STYLES.find(s => s.id === styleId);
    if (selectedStyleObj) {
      session.selectedStyle = selectedStyleObj.id;
      session.state = 'AWAITING_TEXT';
      await updateMenu(chatId, uid, `✏️ <b>Editor (${selectedStyleObj.text})</b>\n\nএখন আপনার কাঙ্ক্ষিত টেক্সট টাইপ করে সেন্ড করুন...`, CANCEL_MENU);
    }
  }
});

// Handle User Messages (Text, Photo, Video)
bot.on('message', async (msg) => {
  const uid = msg.from.id;
  if (uid !== OWNER_ID) return;
  if (msg.text && msg.text.startsWith('/start')) return; // handled separately
  
  const chatId = msg.chat.id;
  const session = getSession(uid);
  
  // Immediately delete user's message to keep chat completely clean
  await safeDelete(chatId, msg.message_id);

  if (session.state === 'IDLE') return; // Do nothing if bot is not expecting a message

  const text = msg.text || msg.caption || '';

  // Handle Repost
  if (session.state === 'AWAITING_REPOST') {
    try {
      await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      resetSession(uid);
      await updateMenu(chatId, uid, `✅ <b>কপি সম্পন্ন! মেসেজ চ্যানেলে পাঠানো হয়েছে।</b>\n\nপরবর্তী কাজ নির্বাচন করুন:`, MAIN_MENU);
    } catch (err) {
      await updateMenu(chatId, uid, `❌ <b>Error!</b> কপি করতে সমস্যা হয়েছে।`, MAIN_MENU);
    }
    return;
  }

  // Handle Media Upload
  if (session.state === 'AWAITING_MEDIA') {
    if (msg.photo) {
      session.mediaId = msg.photo[msg.photo.length - 1].file_id;
      session.mediaType = 'photo';
    } else if (msg.video) {
      session.mediaId = msg.video.file_id;
      session.mediaType = 'video';
    } else {
      await updateMenu(chatId, uid, `⚠️ দয়া করে ছবি অথবা ভিডিও পাঠান!`, CANCEL_MENU);
      return;
    }
    session.mode = 'media_caption';
    session.state = 'IDLE';
    await updateMenu(chatId, uid, `✅ <b>মিডিয়া যুক্ত হয়েছে!</b>\nএবার ক্যাপশনের স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }

  // Handle Raw Text and Spoilers
  if (!text && session.state !== 'AWAITING_MEDIA') return;

  const { textOnly, buttons } = parseButtonsBlock(text);
  const plainText = textOnly.trim();
  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;

  if (session.state === 'AWAITING_RAW' || session.state === 'AWAITING_SPOILER') {
    let finalHtml = plainText;
    if (session.state === 'AWAITING_SPOILER') finalHtml = `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`;
    try {
      await bot.sendMessage(CHANNEL_ID, finalHtml, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      resetSession(uid);
      await updateMenu(chatId, uid, `✅ <b>সফলভাবে চ্যানেলে পোস্ট হয়েছে!</b>\n\nনতুন কাজ নির্বাচন করুন:`, MAIN_MENU);
    } catch (e) {
      await updateMenu(chatId, uid, `❌ <b>Error:</b> HTML ফরম্যাট ভুল হতে পারে।`, MAIN_MENU);
    }
    return;
  }

  // Handle Styled Text
  if (session.state === 'AWAITING_TEXT') {
    let htmlBlock;
    if (session.selectedStyle === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (!parts[0] || !parts[1]) {
        await updateMenu(chatId, uid, `⚠️ লিংক এর ফরম্যাট ভুল। সঠিক ফরম্যাট: <code>Text | https://link.com</code>`, CANCEL_MENU);
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
      await updateMenu(chatId, uid, `🧱 <b>Block #${session.draftBlocks.length} যুক্ত হয়েছে!</b>\nআরও ব্লক যোগ করুন অথবা পাবলিশ করুন:`, getStyleMenu(session));
    } 
    else if (session.mode === 'quick') {
      try {
        await bot.sendMessage(CHANNEL_ID, htmlBlock, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
        resetSession(uid);
        await updateMenu(chatId, uid, `✅ <b>সফলভাবে চ্যানেলে পোস্ট হয়েছে!</b>`, MAIN_MENU);
      } catch (e) {
        await updateMenu(chatId, uid, `❌ <b>Error:</b> পোস্ট করতে সমস্যা হয়েছে।`, MAIN_MENU);
      }
    }
    else if (session.mode === 'media_caption') {
      try {
        const opts = { caption: htmlBlock, parse_mode: 'HTML', reply_markup: replyMarkup };
        if (session.mediaType === 'photo') await bot.sendPhoto(CHANNEL_ID, session.mediaId, opts);
        else await bot.sendVideo(CHANNEL_ID, session.mediaId, opts);
        resetSession(uid);
        await updateMenu(chatId, uid, `✅ <b>সফলভাবে ছবি/ভিডিও চ্যানেলে পোস্ট হয়েছে!</b>`, MAIN_MENU);
      } catch (e) {
        await updateMenu(chatId, uid, `❌ <b>Error:</b> পোস্ট করতে সমস্যা হয়েছে।`, MAIN_MENU);
      }
    }
  }
});
