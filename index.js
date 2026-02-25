// ===============================
//  Telegram Channel Manager Bot (Render Ready + Style Menu)
//  - /menu → স্টাইল সিলেক্ট করার মেনু
//  - স্টাইল সিলেক্ট করার পর, পরের টেক্সট মেসেজ চ্যানেলে ওই স্টাইলে পোস্ট হবে (+ Copy বাটন)
//  - আগের সব ফিচার থাকছে: /post, /post_spoiler, /send
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
// Style session (মেনু থেকে সিলেক্ট করা স্টাইল)
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
    case 'code':
      return 'Inline Code';
    case 'pre':
      return 'Code Block';
    case 'spoiler':
      return 'Spoiler / Blur';
    default:
      return mode;
  }
}

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
    case 'code':
      return `<code>${safe}</code>`;
    case 'pre':
      return `<pre>${safe}</pre>`;
    case 'spoiler':
      return `<tg-spoiler>${safe}</tg-spoiler>`;
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

<b>মেইন মেনু:</b>
<b>/menu</b> → স্টাইল সিলেক্ট করার মেনু (Bold, Italic, Underline, Code, Spoiler, ইত্যাদি)

<b>কমান্ডসমূহ:</b>
<b>/post</b> &lt;b&gt;HTML পোস্ট&lt;/b&gt;
  → নিজে HTML লিখে পোস্ট + Copy বাটন

<b>/post_spoiler</b> লেখাঃ
  → পুরো পোস্ট blur/spoiler আকারে থাকবে + Copy বাটন

<b>/send</b> (reply করে)
  → যে মেসেজে reply করবে, সেটা চ্যানেলে copy হবে
  → যদি টেক্সট/ক্যাপশন থাকে, Copy বাটনও থাকবে

<b>HTML উদাহরণ (/post):</b>
/post &lt;b&gt;বোল্ড&lt;/b&gt; &lt;i&gt;italic&lt;/i&gt; &lt;a href="https://example.com"&gt;লিংক&lt;/a&gt;
`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// ===============================
// /menu কমান্ড: স্টাইল সিলেক্ট করার মেনু
// ===============================
bot.onText(/^\/menu$/, (msg) => {
  const chatId = msg.chat.id;

  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, 'এই মেনু শুধু Owner ব্যবহার করতে পারবে।', {
      reply_to_message_id: msg.message_id,
    });
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Normal', callback_data: 'style:normal' },
        { text: 'Bold', callback_data: 'style:bold' },
      ],
      [
        { text: 'Italic', callback_data: 'style:italic' },
        { text: 'Underline', callback_data: 'style:underline' },
      ],
      [
        { text: 'Strikethrough', callback_data: 'style:strike' },
        { text: 'Inline Code', callback_data: 'style:code' },
      ],
      [
        { text: 'Code Block', callback_data: 'style:pre' },
        { text: 'Spoiler / Blur', callback_data: 'style:spoiler' },
      ],
    ],
  };

  bot.sendMessage(
    chatId,
    '🧷 যে স্টাইলে চ্যানেলে পোস্ট করতে চান, নিচ থেকে সেটি সিলেক্ট করুন:',
    { reply_markup: keyboard }
  );
});

// ===============================
// Callback query (মেনু থেকে স্টাইল সিলেক্ট)
// ===============================
bot.on('callback_query', (query) => {
  const data = query.data;

  if (!data || !data.startsWith('style:')) {
    return bot.answerCallbackQuery(query.id);
  }

  if (!isOwner(query.from)) {
    return bot.answerCallbackQuery(query.id, {
      text: 'এই মেনু শুধু Owner এর জন্য।',
      show_alert: true,
    });
  }

  const mode = data.split(':')[1];
  const userId = query.from.id;
  const chatId = query.message.chat.id;

  setStyleSession(userId, mode);

  const label = styleLabel(mode);

  bot.answerCallbackQuery(query.id, {
    text: `স্টাইল সিলেক্ট হয়েছে: ${label}`,
  });

  bot.sendMessage(
    chatId,
    `✅ "${label}" স্টাইল সিলেক্ট করা হয়েছে।\nএখন যেই টেক্সট পাঠাবেন, আমি সেটাকে এই স্টাইলে চ্যানেলে পোস্ট করবো।`,
    { reply_to_message_id: query.message.message_id }
  );
});

// ===============================
// /post: HTML পোস্ট + Copy বাটন (আগের মতই)
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
// /post_spoiler: spoiler/blur পোস্ট + Copy বাটন (আগের মতই)
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
// - না থাকলে শুধু /send এর hint দেখাবে (আগের মত)
// ===============================
bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  // কমান্ডগুলো এখানে হ্যান্ডল করবো না
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

    const plainText = msg.text;
    const htmlText = buildStyledHtml(state.mode, plainText);
    const replyMarkup = buildCopyKeyboard(plainText);

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

  // কোনো স্টাইল সিলেক্ট নেই → আগের মত hint
  bot.sendMessage(
    chatId,
    'ℹ️ যদি এই মেসেজটা চ্যানেলে পাঠাতে চান:\n👉 এটাতে reply করে /send লিখুন।\n\nঅথবা নতুন স্টাইলে পোস্ট করতে চাইলে আগে /menu দিয়ে স্টাইল সিলেক্ট করুন।',
    { reply_to_message_id: msg.message_id }
  );
});
