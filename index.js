// index.js
// Clean Channel Manager Bot + Multi-style Draft
// - Owner-only
// - Quick Mode: ১ স্টাইল = ১ পোস্ট (আগের মতো)
// - Multi Mode: /multi → এক পোস্টে একাধিক স্টাইল ব্লক → /publish
// - Styles: normal, bold, italic, underline, strike, spoiler, code/copy (one-tap copy), pre, quote,
//           heading, bullets, note, warning, success, info, link
// - /post (raw HTML), /post_spoiler, /send (reply copy)

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;       // e.g. -1001234567890
const OWNER_ID = Number(process.env.OWNER_ID);   // your user id
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
console.log('🤖 Bot polling started');

// ---------- Helpers ----------
function isOwner(x) {
  const id = x.from?.id ?? x.id ?? x.chat?.id;
  return id === OWNER_ID;
}

function escapeHtml(t) {
  if (!t) return '';
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseButtonsBlock(text) {
  // BUTTONS:
  // Label|https://...
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

// ---------- Style session & Draft session ----------
// styleSession: কোন স্টাইল সিলেক্ট করা আছে, পরের মেসেজ কীভাবে ধরবো
//  userId -> { mode, awaitingText, isMulti }
const styleSession = {};
function setStyleSession(userId, mode, isMulti) {
  styleSession[userId] = { mode, awaitingText: true, isMulti: !!isMulti };
}
function clearStyleSession(userId) {
  delete styleSession[userId];
}
function getStyleSession(userId) {
  return styleSession[userId];
}

// draftPosts: multi-mode এর ড্রাফট
// userId -> { blocks: [htmlBlock1, htmlBlock2,...], buttons: [{text,url},...] }
const draftPosts = {};
function getDraft(userId) {
  if (!draftPosts[userId]) {
    draftPosts[userId] = { blocks: [], buttons: [] };
  }
  return draftPosts[userId];
}
function clearDraft(userId) {
  delete draftPosts[userId];
}

// ---------- Styled HTML ----------
function buildStyledHtml(mode, plainText) {
  const safe = escapeHtml(plainText || '');
  switch (mode) {
    case 'normal':   return safe;
    case 'bold':     return `<b>${safe}</b>`;
    case 'italic':   return `<i>${safe}</i>`;
    case 'underline':return `<u>${safe}</u>`;
    case 'strike':   return `<s>${safe}</s>`;
    case 'spoiler':  return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code':
    case 'copy':     return `<code>${safe}</code>`; // tap-to-copy on text
    case 'pre':      return `<pre>${safe}</pre>`;
    case 'quote':    return `<blockquote>${safe}</blockquote>`;
    case 'heading':  return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets': {
      const lines = (plainText || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    }
    case 'note':     return `📌 <b>Note:</b> ${safe}`;
    case 'warning':  return `⚠️ <b>Warning:</b> ${safe}`;
    case 'success':  return `✅ <b>Success:</b> ${safe}`;
    case 'info':     return `ℹ️ <b>Info:</b> ${safe}`;
    default:         return safe;
  }
}

// ---------- /start ----------
const commandListText = `normal - Normal style post
bold - Bold style post
italic - Italic style post
underline - Underline style post
strike - Strikethrough style post
spoiler - Spoiler / blur style post
code - Monospace (tap text to copy)
copy - Same as code
pre - Code block style post
quote - Quote style post
link - Clickable link post (title | https://...)
heading - Heading/title style post
bullets - Bullet list style post (each line)
note - Note style template
warning - Warning style template
success - Success/OK style template
info - Info/notice style template
multi - Start multi-style draft
publish - Send current multi-style draft
cancelmulti - Cancel draft
post - Raw HTML post
post_spoiler - Raw spoiler post
send - Copy replied message to channel`;

bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, 'Hi! This bot is private (owner only).');
  }

  const text = `<b>Welcome to your Channel Manager bot 👑</b>

<b>Quick Mode (১ স্টাইল = ১ পোস্ট):</b>
1️⃣ 4-dot থেকে স্টাইল সিলেক্ট করুন (যেমন /bold, /heading, /copy)  
2️⃣ পরের টেক্সট পাঠান  
→ সাথে সাথে চ্যানেলে ঐ স্টাইলে পোস্ট হয়ে যাবে।

<b>Multi Mode (এক পোস্টে অনেক স্টাইল):</b>
/multi → নতুন ড্রাফট শুরু  
→ এরপর বারবার স্টাইল সিলেক্ট + টেক্সট পাঠান (প্রতিটি টেক্সট একেকটা ব্লক)  
→ ব্লকগুলো জমে থাকবে  
শেষে /publish লিখুন → সব ব্লক একসাথে একটি পোস্ট হিসেবে চ্যানেলে যাবে  
/cancelmulti → ড্রাফট ক্যান্সেল

<b>One-tap Copy:</b>
/code বা /copy ব্যবহার করলে টেক্সট <code>মোনোস্পেস</code> স্টাইলে যাবে।  
Telegram এই স্টাইলে ট্যাপ করলেই এক ট্যাপে কপি হয়।

<b>Inline Link:</b>
/link → তারপর টেক্সট হিসেবে পাঠান:
<code>আমার সাইট | https://example.com</code>

<b>Bullet list:</b>
/bullets → তারপর টেক্সট:
<code>লাইন ১
লাইন ২
লাইন ৩</code>

<b>Raw HTML:</b>
/post &lt;b&gt;Bold HTML&lt;/b&gt;

<b>Repost:</b>
কোনো মেসেজে reply করে /send লিখুন → সেটা চ্যানেলে কপি হবে।

<b>Commands:</b>
<pre>${escapeHtml(commandListText)}</pre>`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

bot.onText(/^\/help$/, (msg) => {
  if (!isOwner(msg)) return;
  bot.sendMessage(msg.chat.id, 'পুরো গাইড দেখতে /start লিখুন।', {
    reply_to_message_id: msg.message_id,
  });
});

// ---------- Multi-mode control ----------
bot.onText(/^\/multi$/, (msg) => {
  if (!isOwner(msg)) return;
  const uid = msg.from.id;
  clearDraft(uid);
  getDraft(uid); // init
  clearStyleSession(uid);
  bot.sendMessage(
    msg.chat.id,
    '🧱 Multi-style পোস্ট মোড শুরু হয়েছে।\n\nএখন 4-dot থেকে স্টাইল বেছে টেক্সট পাঠান (প্রতিটি টেক্সট একেকটি ব্লক হিসেবে সেভ হবে)।\nশেষ হলে /publish লিখুন, ড্রাফট বাতিল করতে /cancelmulti লিখুন।',
    { reply_to_message_id: msg.message_id },
  );
});

bot.onText(/^\/cancelmulti$/, (msg) => {
  if (!isOwner(msg)) return;
  const uid = msg.from.id;
  clearDraft(uid);
  clearStyleSession(uid);
  bot.sendMessage(msg.chat.id, '❌ Multi-style ড্রাফট বাতিল করা হয়েছে।', {
    reply_to_message_id: msg.message_id,
  });
});

bot.onText(/^\/publish$/, (msg) => {
  if (!isOwner(msg)) return;
  const uid = msg.from.id;
  const draft = draftPosts[uid];
  if (!draft || !draft.blocks || draft.blocks.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      'ড্রাফটে কোনো ব্লক নেই। /multi দিয়ে শুরু করুন, তারপর স্টাইল+টেক্সট যোগ করুন।',
      { reply_to_message_id: msg.message_id },
    );
  }
  const html = draft.blocks.join('\n\n');
  const buttons = draft.buttons || [];
  const replyMarkup = buttons.length
    ? { inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]) }
    : undefined;

  bot.sendMessage(CHANNEL_ID, html, {
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: replyMarkup,
  })
    .then(() => {
      bot.sendMessage(msg.chat.id, '✅ Multi-style পোস্ট চ্যানেলে পাঠানো হয়েছে।', {
        reply_to_message_id: msg.message_id,
      });
      clearDraft(uid);
      clearStyleSession(uid);
    })
    .catch((err) => {
      console.error('publish error', err);
      bot.sendMessage(msg.chat.id, '❌ পোস্ট দিতে সমস্যা হয়েছে (bot admin / CHANNEL_ID চেক করুন)।', {
        reply_to_message_id: msg.message_id,
      });
    });
});

// ---------- Style commands ----------
const styleCommands = [
  'normal', 'bold', 'italic', 'underline', 'strike',
  'spoiler', 'code', 'copy', 'pre', 'quote',
  'link', 'heading', 'bullets', 'note', 'warning',
  'success', 'info',
];

function handleStyleCommand(mode, msg) {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Owner only.');

  const uid = msg.from.id;
  const draft = draftPosts[uid];
  const isMulti = !!(draft && draft.blocks);

  setStyleSession(uid, mode, isMulti);

  let hint = 'এখন টেক্সট পাঠান।';
  if (mode === 'link') {
    hint = 'ফরম্যাট: শিরোনাম | https://example.com';
  } else if (mode === 'bullets') {
    hint = 'প্রতিটি পয়েন্ট আলাদা লাইনে লিখুন।';
  } else if (mode === 'code' || mode === 'copy') {
    hint = 'এই স্টাইলের টেক্সটে ট্যাপ করলেই এক ট্যাপে কপি হবে।';
  }

  const modeText = isMulti
    ? `"${mode}" ব্লক সিলেক্ট হয়েছে (Multi-mode)।`
    : `"${mode}" স্টাইল সিলেক্ট হয়েছে (Quick-mode)।`;

  bot.sendMessage(
    msg.chat.id,
    `✅ ${modeText}\n${hint}`,
    { reply_to_message_id: msg.message_id },
  );
}

for (const cmd of styleCommands) {
  bot.onText(new RegExp(`^\\/${cmd}$`), (msg) => handleStyleCommand(cmd, msg));
}

// ---------- /post (raw HTML) ----------
bot.onText(/^\/post\s+([\s\S]+)/, (msg, match) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Owner only.');
  const raw = match[1].trim();
  const { textOnly, buttons } = parseButtonsBlock(raw);
  const replyMarkup = buttons.length
    ? { inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]) }
    : undefined;

  bot.sendMessage(CHANNEL_ID, textOnly, {
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: replyMarkup,
  })
    .then(() => bot.sendMessage(msg.chat.id, '✅ HTML পোস্ট করা হয়েছে।', {
      reply_to_message_id: msg.message_id,
    }))
    .catch((err) => {
      console.error('post error', err);
      bot.sendMessage(msg.chat.id, '❌ পোস্ট পাঠাতে সমস্যা হয়েছে।', {
        reply_to_message_id: msg.message_id,
      });
    });
});

// ---------- /post_spoiler ----------
bot.onText(/^\/post_spoiler\s+([\s\S]+)/, (msg, match) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Owner only.');
  const plain = match[1].trim();
  const html = `<tg-spoiler>${escapeHtml(plain)}</tg-spoiler>`;
  bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML' })
    .then(() => bot.sendMessage(msg.chat.id, '😶‍🌫️ spoiler পোস্ট করা হয়েছে।', {
      reply_to_message_id: msg.message_id,
    }))
    .catch((err) => {
      console.error('post_spoiler error', err);
      bot.sendMessage(msg.chat.id, '❌ spoiler পাঠাতে সমস্যা হয়েছে।', {
        reply_to_message_id: msg.message_id,
      });
    });
});

// ---------- /send (copy replied message) ----------
bot.onText(/^\/send$/, (msg) => {
  if (!isOwner(msg)) return;
  if (!msg.reply_to_message) {
    return bot.sendMessage(
      msg.chat.id,
      'যে মেসেজ চ্যানেলে পাঠাতে চান, সেটিতে reply করে তারপর /send লিখুন।',
      { reply_to_message_id: msg.message_id },
    );
  }

  const src = msg.reply_to_message;
  bot.copyMessage(CHANNEL_ID, msg.chat.id, src.message_id)
    .then(() => bot.sendMessage(msg.chat.id, '✅ মেসেজ চ্যানেলে কপি করা হয়েছে।', {
      reply_to_message_id: msg.message_id,
    }))
    .catch((err) => {
      console.error('copyMessage error', err);
      bot.sendMessage(
        msg.chat.id,
        '❌ কপি করতে সমস্যা হয়েছে (bot admin / CHANNEL_ID চেক করুন)।',
        { reply_to_message_id: msg.message_id },
      );
    });
});

// ---------- General message handler ----------
bot.on('message', (msg) => {
  if (!isOwner(msg)) return;

  // commands already handled
  if (msg.text && msg.text.startsWith('/')) return;

  const uid = msg.from.id;
  const state = getStyleSession(uid);

  if (!state || !state.awaitingText) {
    return bot.sendMessage(
      msg.chat.id,
      'ℹ️ Quick পোস্টের জন্য: 4-dot থেকে স্টাইল সিলেক্ট করে তারপর টেক্সট পাঠান।\nMulti পোস্টের জন্য: আগে /multi, তারপর স্টাইল+টেক্সট, শেষে /publish।',
      { reply_to_message_id: msg.message_id },
    );
  }

  const { mode, isMulti } = state;
  const fullText = msg.text || '';
  const { textOnly, buttons } = parseButtonsBlock(fullText);
  const plainText = textOnly.trim();
  if (!plainText) {
    return bot.sendMessage(msg.chat.id, 'ফাঁকা টেক্সট পাঠানো যাবে না।', {
      reply_to_message_id: msg.message_id,
    });
  }

  if (isMulti) {
    // -------- Multi-mode: block সংগ্রহ --------
    const draft = getDraft(uid);

    // BUTTONS ব্লক থাকলে শেষের সেটটা পুরো ড্রাফটের buttons হিসেবে সেভ
    if (buttons.length) {
      draft.buttons = buttons;
    }

    let htmlBlock;
    if (mode === 'link') {
      const parts = plainText.split('|').map(p => p.trim());
      if (!parts[0] || !parts[1]) {
        return bot.sendMessage(
          msg.chat.id,
          'Link mode ফরম্যাট: Title | https://example.com',
          { reply_to_message_id: msg.message_id },
        );
      }
      let url = parts[1];
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      htmlBlock = `<a href="${escapeHtml(url)}">${escapeHtml(parts[0])}</a>`;
    } else {
      htmlBlock = buildStyledHtml(mode, plainText);
    }

    draft.blocks.push(htmlBlock);
    const blockNum = draft.blocks.length;

    bot.sendMessage(
      msg.chat.id,
      `🧱 Block #${blockNum} যোগ হয়েছে (${mode}).\nআরও স্টাইল বেছে ব্লক করতে পারেন, নাহলে /publish লিখুন।`,
      { reply_to_message_id: msg.message_id },
    );

    clearStyleSession(uid);
    return;
  }

  // -------- Quick-mode: সঙ্গে সঙ্গে পোস্ট --------
  let html;
  if (mode === 'link') {
    const parts = plainText.split('|').map(p => p.trim());
    if (!parts[0] || !parts[1]) {
      return bot.sendMessage(
        msg.chat.id,
        'Link mode ফরম্যাট: Title | https://example.com',
        { reply_to_message_id: msg.message_id },
      );
    }
    let url = parts[1];
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    html = `<a href="${escapeHtml(url)}">${escapeHtml(parts[0])}</a>`;
  } else {
    html = buildStyledHtml(mode, plainText);
  }

  const replyMarkup = buttons.length
    ? { inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]) }
    : undefined;

  bot.sendMessage(CHANNEL_ID, html, {
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: replyMarkup,
  })
    .then(() => {
      bot.sendMessage(msg.chat.id, '✅ চ্যানেলে পোস্ট হয়ে গেছে।', {
        reply_to_message_id: msg.message_id,
      });
      clearStyleSession(uid);
    })
    .catch((err) => {
      console.error('quick-mode send error', err);
      bot.sendMessage(
        msg.chat.id,
        '❌ পোস্ট দিতে সমস্যা হয়েছে (bot admin / CHANNEL_ID চেক করুন)।',
        { reply_to_message_id: msg.message_id },
      );
    });
});
