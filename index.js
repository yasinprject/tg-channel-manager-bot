// ===============================
//  Telegram Channel Manager Bot (Render Ready + Many Styles)
//  - 4-dot menu commands: /normal, /bold, /italic, /underline, /strike, /spoiler,
//    /code, /pre, /quote, /link, /heading, /bullets, /note, /warning, /success, /info
//  - স্টাইল কমান্ড চাপলে → পরের টেক্সট ওই স্টাইলে চ্যানেলে পোস্ট হবে (+ Copy বাটন)
//  - আগের ফিচার: /post, /post_spoiler, /send
// ===============================

require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// --------- ENV -----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // যেমন: -1001234567890
const OWNER_ID = Number(process.env.OWNER_ID); // যেমন: 8486562838
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID || !OWNER_ID) {
  console.error('❌ BOT_TOKEN / CHANNEL_ID / OWNER_ID সেট করা হয়নি (.env চেক করুন)');
  process.exit(1);
}

// --------- EXPRESS (Render health check) -----------
const app = express();
app.get('/', (_req, res) => {
  res.send('✅ Telegram Channel Manager Bot is running.');
});

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

// --------- TELEGRAM BOT (Long Polling) -----------
const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
});

console.log('🤖 Telegram bot polling শুরু হয়েছে...');

// ===============================
// Helper: Owner কিনা চেক
// ===============================
function isOwner(msgOrUser) {
  const id =
    msgOrUser.from?.id ??
    msgOrUser.chat?.id ??
    msgOrUser.id ??
    msgOrUser.from_id;
  return id === OWNER_ID;
}

// ===============================
// Helper: HTML থেকে plain text (Copy বাটনের জন্য)
// ===============================
function htmlToPlainText(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').trim();
}

// ===============================
// Helper: HTML escape (user টেক্সটে <, >, & থাকলে)
// ===============================
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ===============================
// Helper: Copy Button Keyboard (native copy_text)
// ===============================
function buildCopyKeyboard(copyText) {
  if (!copyText) return undefined;
  const limited = copyText.slice(0, 256); // Bot API limit

  return {
    inline_keyboard: [
      [
        {
          text: '📋 Copy',
          copy_text: {
            text: limited,
          },
        },
      ],
    ],
  };
}

// ===============================
// Style session (কোন কমান্ড দিয়ে কোন স্টাইল সিলেক্ট হয়েছে)
// ===============================
const styleSession = {}; // key: userId → { mode, awaitingText }

function setStyleSession(userId, mode) {
  styleSession[userId] = { mode, awaitingText: true };
}

function clearStyleSession(userId) {
  delete styleSession[userId];
}

function getStyleSession(userId) {
  return styleSession[userId];
}

function styleLabel(mode) {
  switch (mode) {
    case 'normal':
      return 'Normal';
    case 'bold':
      return 'Bold';
    case 'italic':
      return 'Italic';
    case 'underline':
      return 'Underline';
    case 'strike':
      return 'Strikethrough';
    case 'spoiler':
      return 'Spoiler / Blur';
    case 'code':
      return 'Inline Code';
    case 'pre':
      return 'Code Block';
    case 'quote':
      return 'Quote';
    case 'link':
      return 'Link';
    case 'heading':
      return 'Heading';
    case 'bullets':
      return 'Bullet List';
    case 'note':
      return 'Note';
    case 'warning':
      return 'Warning';
    case 'success':
      return 'Success';
    case 'info':
      return 'Info';
    default:
      return mode;
  }
}

// সব স্টাইলে (link ছাড়া) কীভাবে HTML বানাবো
function buildStyledHtml(mode, plainText) {
  const safe = escapeHtml(plainText);

  switch (mode) {
    case 'bold':
      return `<b>${safe}</b>`;
    case 'italic':
      return `<i>${safe}</i>`;
    case 'underline':
      return `<u>${safe}</u>`;
    case 'strike':
      return `<s>${safe}</s>`;
    case 'spoiler':
      return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code':
      return `<code>${safe}</code>`;
    case 'pre':
      return `<pre>${safe}</pre>`;
    case 'quote':
      return `<blockquote>${safe}</blockquote>`;
    case 'heading':
      return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets': {
      const lines = safe
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length === 0) return '';
      return lines.map((l) => `• ${l}`).join('\n');
    }
    case 'note':
      return `📌 <b>Note:</b> ${safe}`;
    case 'warning':
      return `⚠️ <b>Warning:</b> ${safe}`;
    case 'success':
      return `✅ <b>Success:</b> ${safe}`;
    case 'info':
      return `ℹ️ <b>Info:</b> ${safe}`;
    case 'normal':
    default:
      return safe;
  }
}

// ===============================
// /start কমান্ড
// ===============================
bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;

  if (!isOwner(msg)) {
    return bot.sendMessage(
      chatId,
      'হাই! 😊\n\nএই বটটি শুধু Owner এর জন্য চ্যানেল ম্যানেজমেন্ট বট হিসেবে ব্যবহার করা হচ্ছে।',
      { reply_to_message_id: msg.message_id }
    );
  }

  const text = `
<b>Welcome, Boss! 👑</b>

এই বট দিয়ে তুমি তোমার চ্যানেলের পোস্টগুলো প্রো-লেভেলে ম্যানেজ করতে পারবে।

<b>স্টাইল কমান্ডসমূহ (4-dot মেনুতে দেখাবে):</b>
/normal, /bold, /italic, /underline, /strike, /spoiler, /code, /pre,
/quote, /link, /heading, /bullets, /note, /warning, /success, /info

<b>কাজের ধাপ:</b>
1️⃣ 4-dot থেকে একটি স্টাইল কমান্ড সিলেক্ট করো (যেমন /bold)
/bold → আমি বলবো "Bold স্টাইল সিলেক্ট হয়েছে..."
2️⃣ তারপর যে টেক্সট পাঠাবে, তা অটো ওই স্টাইলে চ্যানেলে পোস্ট হবে
3️⃣ প্রতিটি পোস্টের নিচে 📋 Copy বাটন থাকবে

<b>অতিরিক্ত কমান্ড:</b>
/post &lt;b&gt;কাস্টম HTML&lt;/b&gt; → নিজে HTML লিখে পোস্ট
/post_spoiler টেক্সট → সরাসরি spoiler/blur পোস্ট
/send (reply করে) → যে মেসেজে reply করবে সেটি চ্যানেলে কপি হবে
`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// ===============================
// Helper: স্টাইল কমান্ড হ্যান্ডলার
// ===============================
function handleStyleCommand(mode, msg) {
  const chatId = msg.chat.id;

  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, 'এই কমান্ড শুধু Owner ব্যবহার করতে পারবে।', {
      reply_to_message_id: msg.message_id,
    });
  }

  const userId = msg.from.id;
  setStyleSession(userId, mode);

  const label = styleLabel(mode);
  let hint = 'এখন যে টেক্সট পাঠাবেন, আমি সেটাকে এই স্টাইলে চ্যানেলে পোস্ট করবো।';

  if (mode === 'link') {
    hint =
      'ফরম্যাট: শিরোনাম | https://example.com\nউদাহরণ: আমার সাইট | https://example.com';
  } else if (mode === 'bullets') {
    hint =
      'প্রতিটি পয়েন্ট আলাদা লাইনে লিখুন। উদাহরণ:\nপয়েন্ট ১\nপয়েন্ট ২\nপয়েন্ট ৩';
  } else if (mode === 'heading') {
    hint = 'এক লাইনের শিরোনাম লিখুন (heading/title)।';
  }

  bot.sendMessage(
    chatId,
    `✅ "${label}" স্টাইল সিলেক্ট করা হয়েছে।\n\n${hint}`,
    { reply_to_message_id: msg.message_id }
  );
}

// ===============================
// স্টাইল কমান্ডগুলো
// ===============================
bot.onText(/^\/normal$/, (msg) => handleStyleCommand('normal', msg));
bot.onText(/^\/bold$/, (msg) => handleStyleCommand('bold', msg));
bot.onText(/^\/italic$/, (msg) => handleStyleCommand('italic', msg));
bot.onText(/^\/underline$/, (msg) => handleStyleCommand('underline', msg));
bot.onText(/^\/strike$/, (msg) => handleStyleCommand('strike', msg));
bot.onText(/^\/spoiler$/, (msg) => handleStyleCommand('spoiler', msg));
bot.onText(/^\/code$/, (msg) => handleStyleCommand('code', msg));
bot.onText(/^\/pre$/, (msg) => handleStyleCommand('pre', msg));
bot.onText(/^\/quote$/, (msg) => handleStyleCommand('quote', msg));
bot.onText(/^\/link$/, (msg) => handleStyleCommand('link', msg));
bot.onText(/^\/heading$/, (msg) => handleStyleCommand('heading', msg));
bot.onText(/^\/bullets$/, (msg) => handleStyleCommand('bullets', msg));
bot.onText(/^\/note$/, (msg) => handleStyleCommand('note', msg));
bot.onText(/^\/warning$/, (msg) => handleStyleCommand('warning', msg));
bot.onText(/^\/success$/, (msg) => handleStyleCommand('success', msg));
bot.onText(/^\/info$/, (msg) => handleStyleCommand('info', msg));

// ===============================
// /post: HTML পোস্ট + Copy বাটন
// ===============================
bot.onText(/^\/post\s+([\s\S]+)/, (msg, match) => {
  const chatId = msg.chat.id;

  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, 'এই কমান্ড শুধু Owner ব্যবহার করতে পারবে।', {
      reply_to_message_id: msg.message_id,
    });
  }

  const htmlText = match[1].trim();
  if (!htmlText) {
    return bot.sendMessage(chatId, 'দয়া করে /post এর পরে HTML টেক্সট লিখুন।', {
      reply_to_message_id: msg.message_id,
    });
  }

  const copyText = htmlToPlainText(htmlText);
  const replyMarkup = buildCopyKeyboard(copyText);

  bot
    .sendMessage(CHANNEL_ID, htmlText, {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_markup: replyMarkup,
    })
    .then(() => {
      bot.sendMessage(chatId, '✅ চ্যানেলে HTML পোস্ট পাঠানো হয়েছে।', {
        reply_to_message_id: msg.message_id,
      });
    })
    .catch((err) => {
      console.error('sendMessage error:', err);
      bot.sendMessage(chatId, '❌ পোস্ট পাঠাতে সমস্যা হয়েছে। Log চেক করুন।', {
        reply_to_message_id: msg.message_id,
      });
    });
});

// ===============================
// /post_spoiler: spoiler/blur পোস্ট + Copy বাটন
// ===============================
bot.onText(/^\/post_spoiler\s+([\s\S]+)/, (msg, match) => {
  const chatId = msg.chat.id;

  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, 'এই কমান্ড শুধু Owner ব্যবহার করতে পারবে।', {
      reply_to_message_id: msg.message_id,
    });
  }

  const plainText = match[1].trim();
  if (!plainText) {
    return bot.sendMessage(
      chatId,
      'দয়া করে /post_spoiler এর পরে টেক্সট লিখুন।',
      {
        reply_to_message_id: msg.message_id,
      }
    );
  }

  const spoilerHtml = `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>`;
  const replyMarkup = buildCopyKeyboard(plainText);

  bot
    .sendMessage(CHANNEL_ID, spoilerHtml, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    })
    .then(() => {
      bot.sendMessage(chatId, '😶‍🌫️ blur/spoiler পোস্ট চ্যানেলে পাঠানো হয়েছে।', {
        reply_to_message_id: msg.message_id,
      });
    })
    .catch((err) => {
      console.error('sendMessage spoiler error:', err);
      bot.sendMessage(chatId, '❌ spoiler পোস্ট পাঠাতে সমস্যা হয়েছে।', {
        reply_to_message_id: msg.message_id,
      });
    });
});

// ===============================
// /send: reply করা মেসেজ চ্যানেলে কপি (+ Copy বাটন থাকলে টেক্সট থেকে)
// ===============================
bot.onText(/^\/send$/, (msg) => {
  const chatId = msg.chat.id;

  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, 'এই কমান্ড শুধু Owner ব্যবহার করতে পারবে।', {
      reply_to_message_id: msg.message_id,
    });
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(
      chatId,
      'যে মেসেজ চ্যানেলে পাঠাতে চান, সেটিতে reply করে তারপর /send লিখুন।',
      {
        reply_to_message_id: msg.message_id,
      }
    );
  }

  const sourceMsg = msg.reply_to_message;

  const originalText =
    sourceMsg.caption ||
    sourceMsg.text ||
    (sourceMsg.poll && sourceMsg.poll.question) ||
    '';

  const replyMarkup = buildCopyKeyboard(originalText);

  bot
    .copyMessage(CHANNEL_ID, chatId, sourceMsg.message_id, {
      reply_markup: replyMarkup,
    })
    .then(() => {
      bot.sendMessage(chatId, '✅ মেসেজ চ্যানেলে কপি করা হয়েছে।', {
        reply_to_message_id: msg.message_id,
      });
    })
    .catch((err) => {
      console.error('copyMessage error:', err);
      bot.sendMessage(
        chatId,
        '❌ মেসেজ কপি করতে সমস্যা হয়েছে। (BOT-এর চ্যানেল permission / টাইপ চেক করুন)',
        {
          reply_to_message_id: msg.message_id,
        }
      );
    });
});

// ===============================
// সাধারণ non-command মেসেজ হ্যান্ডলার
// - যদি styleSession active থাকে → স্টাইল অনুযায়ী পোস্ট করবে
// - না থাকলে শুধু /send এর hint দেখাবে
// ===============================
bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  // কমান্ডগুলোর জন্য আলাদা হ্যান্ডলার আছে, তাই এখানে স্কিপ
  if (msg.text && msg.text.startsWith('/')) return;

  if (!isOwner(msg)) {
    return;
  }

  const state = getStyleSession(msg.from.id);

  // যদি কোনো স্টাইল সিলেক্ট করা থাকে
  if (state && state.awaitingText) {
    if (!msg.text) {
      return bot.sendMessage(
        chatId,
        'এই স্টাইলে শুধু টেক্সট মেসেজ পোস্ট করা যাবে। আবার শুধু টেক্সট পাঠান।',
        { reply_to_message_id: msg.message_id }
      );
    }

    const mode = state.mode;
    const plainText = msg.text;
    let htmlText;
    let copyText;

    if (mode === 'link') {
      const parts = plainText.split('|').map((p) => p.trim());
      const title = parts[0];
      const urlPart = parts[1];

      if (!title || !urlPart) {
        return bot.sendMessage(
          chatId,
          '❗ ফরম্যাট ঠিক করুন:\nশিরোনাম | https://example.com\nউদাহরণ:\nআমার সাইট | https://example.com',
          { reply_to_message_id: msg.message_id }
        );
      }

      let url = urlPart;
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }

      const titleSafe = escapeHtml(title);
      const urlSafe = escapeHtml(url);

      htmlText = `<a href="${urlSafe}">${titleSafe}</a>`;
      copyText = `${title} - ${url}`;
    } else {
      htmlText = buildStyledHtml(mode, plainText);
      if (!htmlText) {
        return bot.sendMessage(
          chatId,
          '❌ টেক্সট ফরম্যাট করতে সমস্যা হয়েছে, আবার চেষ্টা করুন।',
          { reply_to_message_id: msg.message_id }
        );
      }
      copyText = plainText;
    }

    const replyMarkup = buildCopyKeyboard(copyText);

    bot
      .sendMessage(CHANNEL_ID, htmlText, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: replyMarkup,
      })
      .then(() => {
        bot.sendMessage(chatId, '✅ চ্যানেলে পোস্ট করে দিয়েছি।', {
          reply_to_message_id: msg.message_id,
        });
        clearStyleSession(msg.from.id);
      })
      .catch((err) => {
        console.error('styled sendMessage error:', err);
        bot.sendMessage(
          chatId,
          '❌ পোস্ট পাঠাতে সমস্যা হয়েছে। Log চেক করুন।',
          {
            reply_to_message_id: msg.message_id,
          }
        );
      });

    return;
  }

  // কোনো স্টাইল সিলেক্ট নেই → hint
  bot.sendMessage(
    chatId,
    'ℹ️ যদি এই মেসেজটা চ্যানেলে পাঠাতে চান:\n👉 এটাতে reply করে /send লিখুন।\n\nঅথবা 4-dot মেনু থেকে একটি স্টাইল কমান্ড সিলেক্ট করে তারপর টেক্সট পাঠান।',
    { reply_to_message_id: msg.message_id }
  );
});
