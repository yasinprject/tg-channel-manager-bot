// ===============================
//  Telegram Channel Manager Bot (Render Ready)
//  - Owner প্রাইভেট চ্যাটে কমান্ড দেবে
//  - /post <HTML> → চ্যানেলে HTML পোস্ট + Copy বাটন
//  - /post_spoiler <text> → সম্পূর্ণ blur/spoiler পোস্ট + Copy বাটন
//  - /send → কোনো মেসেজে reply করে /send দিলে, সেটি চ্যানেলে copy হবে (+ Copy বাটন যদি টেক্সট থাকে)
//  - GitHub → Render ডিপ্লয়ের জন্য Express server সহ
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

// --------- Helper: Owner কিনা চেক -----------
function isOwner(msg) {
  return msg.from && msg.from.id === OWNER_ID;
}

// --------- Helper: HTML থেকে approximate plain text -----------
function htmlToPlainText(html) {
  if (!html) return '';
  // খুব simple strip, perfect না হলেও Copy বাটনের জন্য যথেষ্ট
  return html.replace(/<[^>]+>/g, '').trim();
}

// --------- Helper: Copy Button Keyboard (native copy_text) -----------
function buildCopyKeyboard(copyText) {
  if (!copyText) return undefined;

  const limited = copyText.slice(0, 256); // Bot API limit: 1-256 chars

  return {
    inline_keyboard: [
      [
        {
          text: '📋 Copy', // বাটনে যেটা দেখা যাবে
          // Bot API-এর native CopyTextButton
          copy_text: {
            text: limited,
          },
        },
      ],
    ],
  };
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

<b>কমান্ডসমূহ:</b>
<b>/post</b> &lt;b&gt;HTML পোস্ট&lt;/b&gt;
  → HTML ফরম্যাটেড পোস্ট + Copy বাটন

<b>/post_spoiler</b> লেখাঃ
  → পুরো পোস্ট blur/spoiler আকারে থাকবে + Copy বাটন

<b>/send</b> (reply করে)
  → যে মেসেজে reply করবে, সেটা চ্যানেলে copy হবে
  → যদি টেক্সট/ক্যাপশন থাকে, Copy বাটনও থাকবে

<b>HTML উদাহরণ:</b>
/post &lt;b&gt;বোল্ড&lt;/b&gt; &lt;i&gt;italic&lt;/i&gt; &lt;a href="https://example.com"&gt;লিংক&lt;/a&gt;
`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// ===============================
// /post কমান্ড: HTML পোস্ট + Copy বাটন
// উদাহরণ: /post <b>Title</b>\n<i>subtitle</i>
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
// /post_spoiler: সম্পূর্ণ blur/spoiler পোস্ট + Copy বাটন
// উদাহরণ: /post_spoiler আজকের hidden অফার ...
// Note: এখানে ধরছি text plain, অতিরিক্ত HTML দিচ্ছো না
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
    return bot.sendMessage(chatId, 'দয়া করে /post_spoiler এর পরে টেক্সট লিখুন।', {
      reply_to_message_id: msg.message_id,
    });
  }

  const spoilerHtml = `<tg-spoiler>${plainText}</tg-spoiler>`;
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
// /send: reply করে /send লিখলে, সেই মেসেজ চ্যানেলে copy হবে
// - text/photo/video/document সবকিছু সাপোর্ট
// - text/caption থাকলে Copy বাটন attach হবে (copy_text)
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

  // কোন টেক্সট copy বাটনে যাবে? text বা caption থেকে নেই
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
// সাধারণ non-command মেসেজ: Owner হলে হিন্ট দেখাবে
// ===============================
bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith('/')) return;

  if (isOwner(msg)) {
    bot.sendMessage(
      chatId,
      'ℹ️ যদি এই মেসেজটা চ্যানেলে পাঠাতে চান:\n👉 এটাতে reply করে /send লিখুন।',
      { reply_to_message_id: msg.message_id }
    );
  }
});
