require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;       
const OWNER_ID = Number(process.env.OWNER_ID);   
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID || !OWNER_ID) {
  process.exit(1);
}

const app = express();
app.get('/', (_req, res) => res.send('Bot is running.'));
app.listen(PORT);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.setMyCommands([]); 

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
      try { await bot.deleteMessage(chatId, msgId); } catch (e) { }
    }
    session.messagesToClean = []; 
  }
}

async function renderMenu(chatId, uid, text, markup) {
  const session = getSession(uid);
  if (session.lastMenuMsgId) {
    try { await bot.deleteMessage(chatId, session.lastMenuMsgId); } catch(e){}
  }
  try {
    const sent = await bot.sendMessage(chatId, text, { 
      parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true 
    });
    session.lastMenuMsgId = sent.message_id;
  } catch(e) {}
}

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

const MAIN_MENU = {
  keyboard: [
    [{ text: '⚡ Quick Mode' }, { text: '🧱 Multi Mode' }],
    [{ text: '🖼️ Media Post' }, { text: '📝 Raw HTML' }],
    [{ text: '🔄 Repost Msg' }, { text: '😶‍🌫️ Spoiler' }],
    [{ text: '❌ Reset Bot' }]
  ],
  resize_keyboard: true
};

const CANCEL_MENU = {
  keyboard: [[{ text: '🔙 Cancel' }]],
  resize_keyboard: true
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
      { text: STYLES[i].text },
      ...(STYLES[i+1] ? [{ text: STYLES[i+1].text }] : [])
    ]);
  }
  if (session.mode === 'multi') {
    keyboard.push([{ text: `🚀 Publish Draft (${session.draftBlocks.length} Blocks)` }]);
  }
  keyboard.push([{ text: '🔙 Back' }]);
  return { keyboard, resize_keyboard: true };
}

bot.onText(/^\/start$/, async (msg) => {
  const uid = msg.from.id;
  if (uid !== OWNER_ID) return;
  const chatId = msg.chat.id;
  const session = getSession(uid);
  
  session.messagesToClean.push(msg.message_id);
  await cleanUserMessages(chatId, uid);
  resetSession(uid);
  
  await renderMenu(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\nস্বাগতম! নিচের মেনু থেকে অপশন নির্বাচন করুন:`, MAIN_MENU);
});

bot.on('message', async (msg) => {
  const uid = msg.from.id;
  if (uid !== OWNER_ID) return;
  if (msg.text && msg.text.startsWith('/start')) return;
  const chatId = msg.chat.id;
  const session = getSession(uid);
  
  session.messagesToClean.push(msg.message_id);

  const text = msg.text || '';

  if (text === '❌ Reset Bot' || text === '🔙 Cancel' || text === '🔙 Back') {
    resetSession(uid);
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `👑 <b>Channel Manager Pro</b>\n\nমেনু থেকে অপশন নির্বাচন করুন:`, MAIN_MENU);
    return;
  }

  if (text === '⚡ Quick Mode') {
    session.mode = 'quick';
    session.state = 'IDLE';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `⚡ <b>Quick Mode</b>\nস্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }

  if (text === '🧱 Multi Mode') {
    session.mode = 'multi';
    session.state = 'IDLE';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `🧱 <b>Multi Mode</b>\nস্টাইল সিলেক্ট করে ব্লক তৈরি করুন:`, getStyleMenu(session));
    return;
  }

  if (text === '🖼️ Media Post') {
    session.state = 'AWAITING_MEDIA';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `🖼️ <b>Media Mode</b>\nআপনার ছবি বা ভিডিওটি পাঠান।`, CANCEL_MENU);
    return;
  }

  if (text === '📝 Raw HTML') {
    session.state = 'AWAITING_RAW';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `📝 <b>Raw HTML</b>\nHTML কোড পাঠান।`, CANCEL_MENU);
    return;
  }

  if (text === '🔄 Repost Msg') {
    session.state = 'AWAITING_REPOST';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `🔄 <b>Repost Mode</b>\nমেসেজটি ফরওয়ার্ড বা সেন্ড করুন।`, CANCEL_MENU);
    return;
  }

  if (text === '😶‍🌫️ Spoiler') {
    session.state = 'AWAITING_SPOILER';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `😶‍🌫️ <b>Raw Spoiler</b>\nটেক্সট পাঠান।`, CANCEL_MENU);
    return;
  }

  if (text.startsWith('🚀 Publish Draft')) {
    if (session.draftBlocks.length === 0) {
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `⚠️ <b>Empty draft!</b>`, getStyleMenu(session));
      return;
    }
    const html = session.draftBlocks.join('\n\n');
    const replyMarkup = session.draftButtons.length ? { inline_keyboard: session.draftButtons } : undefined;
    try {
      await bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      resetSession(uid);
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `✅ <b>সফলভাবে পোস্ট হয়েছে!</b>`, MAIN_MENU);
    } catch (err) {
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `❌ <b>Error posting to channel!</b>`, getStyleMenu(session));
    }
    return;
  }

  const selectedStyleObj = STYLES.find(s => s.text === text);
  if (selectedStyleObj) {
    session.selectedStyle = selectedStyleObj.id;
    session.state = 'AWAITING_TEXT';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `✏️ <b>Editor</b>\nস্টাইল: <b>${selectedStyleObj.id.toUpperCase()}</b>\n\nএখন টেক্সট পাঠান...`, CANCEL_MENU);
    return;
  }

  if (session.state === 'AWAITING_REPOST') {
    try {
      await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      await cleanUserMessages(chatId, uid);
      resetSession(uid);
      await renderMenu(chatId, uid, `✅ <b>কপি সম্পন্ন!</b>`, MAIN_MENU);
    } catch (err) {
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `❌ <b>Error</b>`, MAIN_MENU);
    }
    return;
  }

  if (session.state === 'AWAITING_MEDIA') {
    if (msg.photo) {
      session.mediaId = msg.photo[msg.photo.length - 1].file_id;
      session.mediaType = 'photo';
    } else if (msg.video) {
      session.mediaId = msg.video.file_id;
      session.mediaType = 'video';
    } else {
      await cleanUserMessages(chatId, uid);
      return;
    }
    session.mode = 'media_caption';
    session.state = 'IDLE';
    await cleanUserMessages(chatId, uid);
    await renderMenu(chatId, uid, `✅ <b>মিডিয়া যুক্ত হয়েছে!</b>\nক্যাপশনের স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }

  if (!text) {
    await cleanUserMessages(chatId, uid);
    return;
  }

  const { textOnly, buttons } = parseButtonsBlock(text);
  const plainText = textOnly.trim();
  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;

  if (session.state === 'AWAITING_RAW' || session.state === 'AWAITING_SPOILER') {
    let finalHtml = plainText;
    if (session.state === 'AWAITING_SPOILER') finalHtml = `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`;
    try {
      await bot.sendMessage(CHANNEL_ID, finalHtml, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      await cleanUserMessages(chatId, uid);
      resetSession(uid);
      await renderMenu(chatId, uid, `✅ <b>সফলভাবে পোস্ট হয়েছে!</b>`, MAIN_MENU);
    } catch (e) {
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `❌ <b>Error</b>`, MAIN_MENU);
    }
    return;
  }

  if (session.state === 'AWAITING_TEXT') {
    let htmlBlock;
    if (session.selectedStyle === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (!parts[0] || !parts[1]) {
        await cleanUserMessages(chatId, uid);
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
      await cleanUserMessages(chatId, uid);
      await renderMenu(chatId, uid, `🧱 <b>Block #${session.draftBlocks.length} Added!</b>`, getStyleMenu(session));
    } 
    else if (session.mode === 'quick') {
      try {
        await bot.sendMessage(CHANNEL_ID, htmlBlock, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
        await cleanUserMessages(chatId, uid);
        resetSession(uid);
        await renderMenu(chatId, uid, `✅ <b>সফলভাবে পোস্ট হয়েছে!</b>`, MAIN_MENU);
      } catch (e) {
        await cleanUserMessages(chatId, uid);
        await renderMenu(chatId, uid, `❌ <b>Error</b>`, MAIN_MENU);
      }
    }
    else if (session.mode === 'media_caption') {
      try {
        const opts = { caption: htmlBlock, parse_mode: 'HTML', reply_markup: replyMarkup };
        if (session.mediaType === 'photo') await bot.sendPhoto(CHANNEL_ID, session.mediaId, opts);
        else await bot.sendVideo(CHANNEL_ID, session.mediaId, opts);
        await cleanUserMessages(chatId, uid);
        resetSession(uid);
        await renderMenu(chatId, uid, `✅ <b>সফলভাবে পোস্ট হয়েছে!</b>`, MAIN_MENU);
      } catch (e) {
        await cleanUserMessages(chatId, uid);
        await renderMenu(chatId, uid, `❌ <b>Error</b>`, MAIN_MENU);
      }
    }
    return;
  }

  await cleanUserMessages(chatId, uid);
});
