require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;       
const OWNER_ID = Number(process.env.OWNER_ID);   
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID || !OWNER_ID) {
  console.error("Missing Environment Variables!");
  process.exit(1);
}

// Dummy Express Server
const app = express();
app.get('/', (req, res) => res.send('Channel Manager Pro Bot is Online & Running Smoothly.'));
app.listen(PORT);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.setMyCommands([{ command: '/start', description: 'Main Menu / Restart Bot' }]);

// --- SESSION MANAGEMENT ---
const sessions = {};

function getSession(uid) {
  if (!sessions[uid]) {
    sessions[uid] = defaultSession();
  }
  return sessions[uid];
}

function defaultSession() {
  return {
    state: 'IDLE',          // IDLE, WAIT_MEDIA, WAIT_STYLE, WAIT_TEXT, WAIT_RAW, WAIT_REPOST
    mode: null,             // quick, multi, media
    selectedStyle: 'normal',
    postType: 'text',       // text, photo, video
    mediaId: null,
    draftBlocks: [],
    draftButtons: [],
    lastMenuMsgId: null
  };
}

function resetSession(uid, keepMenuId = true) {
  const lastId = sessions[uid]?.lastMenuMsgId;
  sessions[uid] = defaultSession();
  if (keepMenuId) sessions[uid].lastMenuMsgId = lastId;
}

// --- UTILITIES ---
function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function safeDelete(chatId, msgId) {
  try { await bot.deleteMessage(chatId, msgId); } catch (e) { /* Ignore */ }
}

function parseButtonsBlock(text) {
  if (!text) return { textOnly: '', buttons: [] };
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

// --- HTML BUILDER (PREMIUM STYLES) ---
function buildStyledHtml(style, plainText) {
  const safe = escapeHtml(plainText || '');
  const lines = (plainText || '').split('\n').map(l => l.trim()).filter(Boolean);
  
  switch (style) {
    case 'normal':       return safe;
    case 'title':        return `🏆 <b>${safe.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━`;
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
    case 'numbered':     return lines.map((l, i) => `<b>${i+1}.</b> ${escapeHtml(l)}`).join('\n');
    case 'pros':         return lines.map(l => `✅ ${escapeHtml(l)}`).join('\n');
    case 'cons':         return lines.map(l => `❌ ${escapeHtml(l)}`).join('\n');
    case 'note':         return `📌 <b>Note:</b> ${safe}`;
    case 'warning':      return `⚠️ <b>Warning:</b> ${safe}`;
    case 'signature':    return `\n<i>— ${safe}</i>`;
    default:             return safe;
  }
}

// --- MENUS ---
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: '⚡ Quick Mode', callback_data: 'mode_quick' }, { text: '🧱 Multi-Block Mode', callback_data: 'mode_multi' }],
    [{ text: '🖼️ Media (Photo/Video)', callback_data: 'mode_media' }],
    [{ text: '📝 Raw HTML', callback_data: 'mode_raw' }, { text: '😶‍🌫️ Secret Spoiler', callback_data: 'mode_spoiler' }],
    [{ text: '🔄 Repost Message', callback_data: 'mode_repost' }],
    [{ text: '❌ Refresh / Reset Bot', callback_data: 'reset' }]
  ]
};

const CANCEL_MENU = {
  inline_keyboard: [[{ text: '🔙 Cancel & Go Back', callback_data: 'cancel' }]]
};

const STYLES = [
  { id: 'normal', text: 'Normal 🔤' },      { id: 'title', text: '🏆 Title' },
  { id: 'bold', text: '𝗕𝗼𝗹𝗱' },             { id: 'italic', text: '𝙄𝙩𝙖𝙡𝙞𝙘' },
  { id: 'underline', text: 'U̲n̲d̲e̲r̲l̲i̲n̲e̲' },    { id: 'strike', text: 'S̶t̶r̶i̶k̶e̶' },
  { id: 'heading', text: '🔹 Heading' },    { id: 'quote', text: '❝ Quote' },
  { id: 'expand_quote', text: '📖 Exp. Quote' }, { id: 'spoiler', text: '🌫️ Spoiler' },
  { id: 'code', text: '𝙲𝚘𝚍𝚎 (Copy)' },      { id: 'pre', text: '💻 Code Block' },
  { id: 'bullets', text: '• Bullets' },     { id: 'numbered', text: '1️⃣ Numbered' },
  { id: 'pros', text: '✅ Pros' },          { id: 'cons', text: '❌ Cons' },
  { id: 'note', text: '📌 Note' },          { id: 'warning', text: '⚠️ Warning' },
  { id: 'link', text: '🔗 Text Link' },     { id: 'signature', text: '✍️ Signature' }
];

function getStyleMenu(session) {
  const keyboard = [];
  
  // Custom action for Media Mode
  if (session.mode === 'media') {
    keyboard.push([{ text: '🚀 Skip Caption (Direct Post)', callback_data: 'action_skip_caption' }]);
  }

  // Populate Styles
  for (let i = 0; i < STYLES.length; i += 2) {
    keyboard.push([
      { text: STYLES[i].text, callback_data: `style_${STYLES[i].id}` },
      ...(STYLES[i+1] ? [{ text: STYLES[i+1].text, callback_data: `style_${STYLES[i+1].id}` }] : [])
    ]);
  }
  
  // Custom actions for Multi Mode
  if (session.mode === 'multi' && session.draftBlocks.length > 0) {
    keyboard.push([{ text: `🚀 Publish Now (${session.draftBlocks.length} Blocks ready)`, callback_data: 'action_publish' }]);
    keyboard.push([{ text: `🗑️ Clear Draft`, callback_data: 'action_clear_draft' }]);
  }
  
  keyboard.push([{ text: '🔙 Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: keyboard };
}

// --- UI UPDATER (The Core Fix for "Abnormal" Behavior) ---
async function updateUI(chatId, uid, text, markup) {
  const session = getSession(uid);
  
  if (session.lastMenuMsgId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: session.lastMenuMsgId,
        parse_mode: 'HTML',
        reply_markup: markup,
        disable_web_page_preview: true
      });
      return; // Successfully edited
    } catch (err) {
      const errMsg = err.response?.body?.description || "";
      // If Telegram says exactly the same, do nothing. It's not a bug.
      if (errMsg.includes('exactly the same') || errMsg.includes('not modified')) {
        return; 
      }
      // If message is too old or deleted, we delete from record and send a new one below
      await safeDelete(chatId, session.lastMenuMsgId);
    }
  }

  // Send a completely new menu message
  try {
    const sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });
    session.lastMenuMsgId = sentMsg.message_id;
  } catch (e) {
    console.error("Failed to send UI:", e);
  }
}

// --- COMMAND: /start ---
bot.onText(/^\/start$/, async (msg) => {
  const uid = msg.from.id;
  if (uid !== OWNER_ID) return;
  const chatId = msg.chat.id;
  
  await safeDelete(chatId, msg.message_id); // Delete user's command
  resetSession(uid, false); 
  
  await updateUI(chatId, uid, `👑 <b>Channel Manager Pro v3.0</b>\n\nস্বাগতম! আপনার চ্যানেল ম্যানেজ করার জন্য নিচের মেনু থেকে একটি অপশন নির্বাচন করুন:`, MAIN_MENU);
});

// --- BUTTON CLICKS (CALLBACK QUERIES) ---
bot.on('callback_query', async (query) => {
  const uid = query.from.id;
  if (uid !== OWNER_ID) {
    return bot.answerCallbackQuery(query.id, { text: "⚠️ Not Authorized!", show_alert: true });
  }
  
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(uid);

  bot.answerCallbackQuery(query.id).catch(()=>{});

  // 1. Navigation & Cancels
  if (data === 'cancel' || data === 'reset') {
    resetSession(uid);
    await updateUI(chatId, uid, `🏠 <b>Main Menu</b>\n\nঅপারেশন বাতিল করা হয়েছে। নতুন করে অপশন নির্বাচন করুন:`, MAIN_MENU);
    return;
  }

  // 2. Main Menu Mode Selections
  if (data.startsWith('mode_')) {
    const selectedMode = data.replace('mode_', '');
    session.mode = selectedMode;
    
    if (selectedMode === 'quick') {
      session.state = 'WAIT_STYLE';
      session.postType = 'text';
      await updateUI(chatId, uid, `⚡ <b>Quick Text Mode</b>\n\nটেক্সটের স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    } 
    else if (selectedMode === 'multi') {
      session.state = 'WAIT_STYLE';
      session.postType = 'text';
      await updateUI(chatId, uid, `🧱 <b>Multi-Block Mode</b>\n(একাধিক স্টাইল একসাথে যুক্ত করুন)\n\nপ্রথম ব্লকের জন্য স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    } 
    else if (selectedMode === 'media') {
      session.state = 'WAIT_MEDIA';
      await updateUI(chatId, uid, `🖼️ <b>Media Mode</b>\n\nদয়া করে আপনার <b>Photo</b> অথবা <b>Video</b> টি এখানে সেন্ড করুন...`, CANCEL_MENU);
    }
    else if (selectedMode === 'raw') {
      session.state = 'WAIT_RAW';
      await updateUI(chatId, uid, `📝 <b>Raw HTML Mode</b>\n\nসরাসরি HTML কোড টাইপ করে সেন্ড করুন...`, CANCEL_MENU);
    }
    else if (selectedMode === 'spoiler') {
      session.state = 'WAIT_SPOILER';
      await updateUI(chatId, uid, `😶‍🌫️ <b>Secret Spoiler Mode</b>\n\nযে টেক্সটটি হাইড করে রাখতে চান সেটি সেন্ড করুন...`, CANCEL_MENU);
    }
    else if (selectedMode === 'repost') {
      session.state = 'WAIT_REPOST';
      await updateUI(chatId, uid, `🔄 <b>Repost Mode</b>\n\nঅন্য কোনো চ্যানেল বা চ্যাট থেকে মেসেজটি ফরওয়ার্ড বা সেন্ড করুন...`, CANCEL_MENU);
    }
    return;
  }

  // 3. Style Selection
  if (data.startsWith('style_')) {
    session.selectedStyle = data.replace('style_', '');
    session.state = 'WAIT_TEXT';
    
    const styleName = STYLES.find(s => s.id === session.selectedStyle)?.text || session.selectedStyle;
    
    let instructions = `✏️ <b>Editor (${styleName})</b>\n\nএখন আপনার টেক্সট টাইপ করে সেন্ড করুন...`;
    if(session.selectedStyle === 'link') {
        instructions += `\n\n💡 <b>নিয়ম:</b> <code>Text | URL</code> ফরম্যাটে পাঠান।\nউদাহরণ: <code>Google | https://google.com</code>`;
    } else {
        instructions += `\n\n💡 <i>বাটন যুক্ত করতে মেসেজের শেষে <code>BUTTONS: Name | URL</code> ব্যবহার করুন।</i>`;
    }

    await updateUI(chatId, uid, instructions, CANCEL_MENU);
    return;
  }

  // 4. Custom Actions
  if (data === 'action_publish') {
    if (session.draftBlocks.length === 0) return;
    const finalHtml = session.draftBlocks.join('\n\n');
    const replyMarkup = session.draftButtons.length ? { inline_keyboard: session.draftButtons } : undefined;
    try {
      await bot.sendMessage(CHANNEL_ID, finalHtml, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      resetSession(uid);
      await updateUI(chatId, uid, `✅ <b>সফলভাবে পোস্ট পাবলিশ হয়েছে!</b> 🎉\n\nনতুন কিছু করতে চাইলে মেনু থেকে সিলেক্ট করুন:`, MAIN_MENU);
    } catch (err) {
      await updateUI(chatId, uid, `❌ <b>Error:</b> পোস্ট করতে ব্যর্থ হয়েছে। HTML ট্যাগে ভুল থাকতে পারে।`, getStyleMenu(session));
    }
    return;
  }

  if (data === 'action_clear_draft') {
    session.draftBlocks = [];
    session.draftButtons = [];
    await updateUI(chatId, uid, `🗑️ <b>Draft Cleared!</b>\n\nনতুন করে ব্লক তৈরি করতে স্টাইল সিলেক্ট করুন:`, getStyleMenu(session));
    return;
  }

  if (data === 'action_skip_caption') {
    try {
      if (session.postType === 'photo') {
          await bot.sendPhoto(CHANNEL_ID, session.mediaId);
      } else {
          await bot.sendVideo(CHANNEL_ID, session.mediaId);
      }
      resetSession(uid);
      await updateUI(chatId, uid, `✅ <b>সফলভাবে ছবি/ভিডিও (ক্যাপশন ছাড়া) চ্যানেলে পোস্ট হয়েছে!</b> 🎉`, MAIN_MENU);
    } catch (e) {
      await updateUI(chatId, uid, `❌ <b>Error:</b> মিডিয়া পোস্ট করতে ব্যর্থ হয়েছে।`, CANCEL_MENU);
    }
    return;
  }
});

// --- MESSAGE HANDLER (TEXT, PHOTOS, VIDEOS) ---
bot.on('message', async (msg) => {
  const uid = msg.from.id;
  if (uid !== OWNER_ID) return;
  if (msg.text && msg.text.startsWith('/start')) return; 
  
  const chatId = msg.chat.id;
  const session = getSession(uid);
  
  // Ghost Mode: Delete user's message to keep chat absolutely clean
  await safeDelete(chatId, msg.message_id);

  if (session.state === 'IDLE') return;

  const rawText = msg.text || msg.caption || '';

  // 1. Handling Repost
  if (session.state === 'WAIT_REPOST') {
    try {
      await bot.copyMessage(CHANNEL_ID, chatId, msg.message_id);
      resetSession(uid);
      await updateUI(chatId, uid, `✅ <b>সফলভাবে কপি করে চ্যানেলে পাঠানো হয়েছে!</b>\n\nপরবর্তী কাজ নির্বাচন করুন:`, MAIN_MENU);
    } catch (err) {
      await updateUI(chatId, uid, `❌ <b>Error!</b> মেসেজ কপি করতে সমস্যা হয়েছে।`, CANCEL_MENU);
    }
    return;
  }

  // 2. Handling Media Upload
  if (session.state === 'WAIT_MEDIA') {
    if (msg.photo) {
      session.mediaId = msg.photo[msg.photo.length - 1].file_id;
      session.postType = 'photo';
    } else if (msg.video) {
      session.mediaId = msg.video.file_id;
      session.postType = 'video';
    } else {
      await updateUI(chatId, uid, `⚠️ <b>ভুল ইনপুট!</b> দয়া করে শুধুমাত্র ছবি অথবা ভিডিও সেন্ড করুন।`, CANCEL_MENU);
      return;
    }
    session.state = 'WAIT_STYLE';
    await updateUI(chatId, uid, `✅ <b>মিডিয়া গ্রহণ করা হয়েছে!</b>\n\nএখন এই ছবি/ভিডিওর ক্যাপশনের জন্য স্টাইল সিলেক্ট করুন, অথবা "Skip Caption" এ ক্লিক করুন:`, getStyleMenu(session));
    return;
  }

  // Require text for remaining states
  if (!rawText) {
      await updateUI(chatId, uid, `⚠️ <b>টেক্সট পাওয়া যায়নি!</b> দয়া করে টেক্সট লিখে সেন্ড করুন।`, CANCEL_MENU);
      return;
  }

  const { textOnly, buttons } = parseButtonsBlock(rawText);
  const plainText = textOnly.trim();
  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;

  // 3. Handling Raw HTML & Spoilers
  if (session.state === 'WAIT_RAW' || session.state === 'WAIT_SPOILER') {
    let finalHtml = plainText;
    if (session.state === 'WAIT_SPOILER') {
        finalHtml = `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`;
    }
    try {
      await bot.sendMessage(CHANNEL_ID, finalHtml, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
      resetSession(uid);
      await updateUI(chatId, uid, `✅ <b>সফলভাবে চ্যানেলে পোস্ট হয়েছে!</b>\n\nনতুন কাজ নির্বাচন করুন:`, MAIN_MENU);
    } catch (e) {
      await updateUI(chatId, uid, `❌ <b>HTML Error:</b> আপনার দেওয়া ফরম্যাটে ভুল আছে বা ট্যাগগুলো সঠিকভাবে ক্লোজ করা হয়নি।`, CANCEL_MENU);
    }
    return;
  }

  // 4. Handling Styled Text (Quick, Multi, Media Captions)
  if (session.state === 'WAIT_TEXT') {
    let htmlBlock;
    
    // Custom logic for Links
    if (session.selectedStyle === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (parts.length < 2) {
        await updateUI(chatId, uid, `⚠️ <b>লিংক এর ফরম্যাট ভুল!</b>\nসঠিক নিয়ম: <code>টেক্সট | https://example.com</code>`, CANCEL_MENU);
        return;
      }
      let url = parts[1];
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      htmlBlock = `<a href="${escapeHtml(url)}">${escapeHtml(parts[0])}</a>`;
    } else {
      htmlBlock = buildStyledHtml(session.selectedStyle, plainText);
    }

    // Processing based on Mode
    if (session.mode === 'multi') {
      session.draftBlocks.push(htmlBlock);
      if (buttons.length) session.draftButtons = buttons; // Overwrites previous buttons with latest ones
      session.state = 'WAIT_STYLE';
      await updateUI(chatId, uid, `🧱 <b>Block #${session.draftBlocks.length} যুক্ত হয়েছে!</b>\n\nপরবর্তী ব্লকের স্টাইল সিলেক্ট করুন অথবা পাবলিশ করুন:`, getStyleMenu(session));
    } 
    else if (session.mode === 'quick' && session.postType === 'text') {
      try {
        await bot.sendMessage(CHANNEL_ID, htmlBlock, { parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
        resetSession(uid);
        await updateUI(chatId, uid, `✅ <b>সফলভাবে চ্যানেলে পোস্ট হয়েছে!</b> 🎉`, MAIN_MENU);
      } catch (e) {
        await updateUI(chatId, uid, `❌ <b>Error:</b> পোস্ট করতে ব্যর্থ হয়েছে।`, CANCEL_MENU);
      }
    }
    else if (session.mode === 'media' && session.postType !== 'text') {
      try {
        const opts = { caption: htmlBlock, parse_mode: 'HTML', reply_markup: replyMarkup };
        if (session.postType === 'photo') {
            await bot.sendPhoto(CHANNEL_ID, session.mediaId, opts);
        } else {
            await bot.sendVideo(CHANNEL_ID, session.mediaId, opts);
        }
        resetSession(uid);
        await updateUI(chatId, uid, `✅ <b>সফলভাবে ছবি/ভিডিও চ্যানেলে পোস্ট হয়েছে!</b> 🎉`, MAIN_MENU);
      } catch (e) {
        await updateUI(chatId, uid, `❌ <b>Error:</b> মিডিয়া পোস্ট করতে ব্যর্থ হয়েছে। ক্যাপশন খুব বড় হতে পারে।`, CANCEL_MENU);
      }
    }
  }
});
