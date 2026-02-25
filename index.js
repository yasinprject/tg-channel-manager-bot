// Telegram Channel Manager Bot — Featureful version
// - Optional per-post Copy button (global toggle + per-post override)
// - Card / CTA templates
// - Many text styles (bold, italic, underline, strike, spoiler, code, pre, quote, link, heading, bullets, note, warning, success, info)
// - /post, /post_spoiler, /send remain
// - Usage: set BOT_TOKEN, CHANNEL_ID, OWNER_ID in Render environment variables
// Note: Bot must be admin in the channel with Post Messages permission

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OWNER_ID = Number(process.env.OWNER_ID);
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID || !OWNER_ID) {
  console.error('ERROR: BOT_TOKEN / CHANNEL_ID / OWNER_ID missing in env');
  process.exit(1);
}

// health check (Render)
const app = express();
app.get('/', (_req, res) => res.send('✅ Telegram Channel Manager Bot is running.'));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('Bot polling started...');

// --------------------- utility helpers ---------------------
function isOwner(msgOrUser) {
  const id = msgOrUser.from?.id ?? msgOrUser.id ?? msgOrUser.chat?.id;
  return id === OWNER_ID;
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlToPlainText(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').trim();
}

function buildCopyKeyboard(copyText) {
  if (!copyText) return undefined;
  // copy_text payload limited; send trimmed version (Telegram client handles it)
  const trimmed = copyText.slice(0, 1024); // safe slice
  return {
    inline_keyboard: [
      [
        {
          text: '📋 Copy',
          copy_text: { text: trimmed },
        },
      ],
    ],
  };
}

// --------------------- session & settings ---------------------
// hold which style user selected and awaiting next text
const styleSession = {}; // userId -> { mode, awaitingText, extra } 
// simple owner-only setting for default copy behavior (true => attach copy by default)
const ownerSettings = {
  defaultCopy: true,
};

function setStyleSession(userId, mode, extra = {}) {
  styleSession[userId] = { mode, awaitingText: true, extra };
}
function clearStyleSession(userId) {
  delete styleSession[userId];
}
function getStyleSession(userId) {
  return styleSession[userId];
}

// --------------------- style builders ---------------------
function styleLabel(mode) {
  const map = {
    normal: 'Normal',
    bold: 'Bold',
    italic: 'Italic',
    underline: 'Underline',
    strike: 'Strikethrough',
    spoiler: 'Spoiler / Blur',
    code: 'Inline Code',
    pre: 'Code Block',
    quote: 'Quote',
    link: 'Link',
    heading: 'Heading',
    bullets: 'Bullet List',
    note: 'Note',
    warning: 'Warning',
    success: 'Success',
    info: 'Info',
    card: 'Card',
    cta: 'Call-to-action',
  };
  return map[mode] ?? mode;
}

function buildStyledHtml(mode, plainText, extra = {}) {
  const safe = escapeHtml(plainText);
  switch (mode) {
    case 'bold': return `<b>${safe}</b>`;
    case 'italic': return `<i>${safe}</i>`;
    case 'underline': return `<u>${safe}</u>`;
    case 'strike': return `<s>${safe}</s>`;
    case 'spoiler': return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code': return `<code>${safe}</code>`;
    case 'pre': return `<pre>${safe}</pre>`;
    case 'quote': return `<blockquote>${safe}</blockquote>`;
    case 'heading': return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets': {
      const lines = safe.split('\n').map(l => l.trim()).filter(Boolean);
      return lines.map(l => `• ${l}`).join('\n');
    }
    case 'note': return `📌 <b>Note:</b> ${safe}`;
    case 'warning': return `⚠️ <b>Warning:</b> ${safe}`;
    case 'success': return `✅ <b>Success:</b> ${safe}`;
    case 'info': return `ℹ️ <b>Info:</b> ${safe}`;
    default: return safe;
  }
}

// --------------------- /start (help + feature list) ---------------------
bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg)) {
    return bot.sendMessage(chatId, 'Hi — This bot is owner-only for channel management.');
  }

  const text = `
<b>Welcome — Channel Manager (Modern)</b>

এই বটটি চ্যানেল পোস্টগুলো প্রফেশনালভাবে পাঠাতে সাহায্য করে — text styles, card / CTA, bullet lists, spoilers, code blocks এবং optional Copy button.

<b>Usage (quick):</b>
1) ৪-dot menu থেকে একটি কমান্ড সিলেক্ট করুন (যেমন /bold বা /card).  
2) বট বলবে "style selected" → এখন টেক্সট/ইনপুট পাঠান।  
3) বট আপনার চ্যানেলে স্টাইলড পোস্ট করবে।

<b>Main commands:</b>
/normal /bold /italic /underline /strike /spoiler /code /pre /quote /link /heading /bullets /note /warning /success /info
/post &lt;HTML&gt; → raw HTML post
/post_spoiler &lt;text&gt; → raw spoiler
/send (reply to message) → copy that message to channel

<b>Copy button control:</b>
/copy_on  - enable default copy button for your posts
/copy_off - disable default copy button for your posts

You can override per-post by prefixing your message with:
[copY] or [copy]  → force attach copy for that post
[nocopy] or [no copy] → force no copy for that post

<b>Card / CTA templates:</b>
/card → format: Title | Description | IMAGE_URL | ButtonText | ButtonURL
Example:
/card Super Drop | New files available | https://i.imgur.com/xxx.jpg | Download | https://t.me/...
/cta → format: Title | URL1_Text | URL1 | URL2_Text | URL2

<b>Notes:</b>
• Ensure bot is Admin in the channel (Post Messages).  
• Set BotFather commands list (we discussed earlier).  
• For advanced features, send logs if errors occur.

Happy posting! ✨
`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// --------------------- copy toggle commands ---------------------
bot.onText(/^\/copy_on$/, (msg) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner can change this.');
  ownerSettings.defaultCopy = true;
  bot.sendMessage(msg.chat.id, '✅ Default copy button is now ON (attached to posts by default).');
});
bot.onText(/^\/copy_off$/, (msg) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner can change this.');
  ownerSettings.defaultCopy = false;
  bot.sendMessage(msg.chat.id, '✅ Default copy button is now OFF (no copy attached by default).');
});

// --------------------- style command handler factory ---------------------
function handleStyleCommand(mode, hint) {
  return (msg) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner can use styles.');
    const userId = msg.from.id;
    setStyleSession(userId, mode);
    let help = hint || 'এখন যে টেক্সট পাঠাবেন, আমি সেটাকে এই স্টাইলে চ্যানেলে পোস্ট করবো।';
    bot.sendMessage(msg.chat.id, `✅ "${styleLabel(mode)}" selected.\n\n${help}`);
  };
}

// register text-style commands
bot.onText(/^\/normal$/, handleStyleCommand('normal'));
bot.onText(/^\/bold$/, handleStyleCommand('bold'));
bot.onText(/^\/italic$/, handleStyleCommand('italic'));
bot.onText(/^\/underline$/, handleStyleCommand('underline'));
bot.onText(/^\/strike$/, handleStyleCommand('strike'));
bot.onText(/^\/spoiler$/, handleStyleCommand('spoiler'));
bot.onText(/^\/code$/, handleStyleCommand('code'));
bot.onText(/^\/pre$/, handleStyleCommand('pre'));
bot.onText(/^\/quote$/, handleStyleCommand('quote'));
bot.onText(/^\/link$/, handleStyleCommand('link', 'Format: Title | https://example.com'));
bot.onText(/^\/heading$/, handleStyleCommand('heading'));
bot.onText(/^\/bullets$/, handleStyleCommand('bullets', 'Write each bullet on a new line.'));
bot.onText(/^\/note$/, handleStyleCommand('note'));
bot.onText(/^\/warning$/, handleStyleCommand('warning'));
bot.onText(/^\/success$/, handleStyleCommand('success'));
bot.onText(/^\/info$/, handleStyleCommand('info'));

// --------------------- /post and /post_spoiler and /send ---------------------
bot.onText(/^\/post\s+([\s\S]+)/, (msg, match) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner.');
  const html = match[1].trim();
  const copyText = htmlToPlainText(html);
  const keyboard = ownerSettings.defaultCopy ? buildCopyKeyboard(copyText) : undefined;
  bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: keyboard })
    .then(() => bot.sendMessage(msg.chat.id, '✅ HTML posted.'))
    .catch(err => {
      console.error('post error:', err?.response?.body || err.message || err);
      bot.sendMessage(msg.chat.id, '❌ Error posting. Send logs.');
    });
});

bot.onText(/^\/post_spoiler\s+([\s\S]+)/, (msg, match) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner.');
  const t = match[1].trim();
  const html = `<tg-spoiler>${escapeHtml(t)}</tg-spoiler>`;
  const keyboard = ownerSettings.defaultCopy ? buildCopyKeyboard(t) : undefined;
  bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: keyboard })
    .then(() => bot.sendMessage(msg.chat.id, '✅ Spoiler posted.'))
    .catch(err => {
      console.error('post_spoiler error:', err?.response?.body || err.message || err);
      bot.sendMessage(msg.chat.id, '❌ Error posting.');
    });
});

bot.onText(/^\/send$/, (msg) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner.');
  if (!msg.reply_to_message) return bot.sendMessage(msg.chat.id, 'Reply to the message then /send.');
  const source = msg.reply_to_message;
  const text = source.caption || source.text || '';
  const keyboard = ownerSettings.defaultCopy ? buildCopyKeyboard(text) : undefined;

  bot.copyMessage(CHANNEL_ID, msg.chat.id, source.message_id, { reply_markup: keyboard })
    .then(() => bot.sendMessage(msg.chat.id, '✅ Message copied to channel.'))
    .catch(err => {
      console.error('copyMessage error:', err?.response?.body || err.message || err);
      bot.sendMessage(msg.chat.id, '❌ Error copying message. Ensure bot is admin in channel.');
    });
});

// --------------------- Card and CTA templates ---------------------
/*
Card format:
/card Title | Description | IMAGE_URL | ButtonText | ButtonURL
Example:
/card Super Drop | Files uploaded | https://i.imgur.com/xxx.jpg | Download | https://t.me/...
*/
bot.onText(/^\/card\s+([\s\S]+)/, (msg, match) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner.');
  const raw = match[1].trim();
  const parts = raw.split('|').map(p => p.trim());
  if (parts.length < 4) {
    return bot.sendMessage(msg.chat.id, 'Format: Title | Description | IMAGE_URL | ButtonText | ButtonURL(optional)');
  }
  const [title, desc, imageUrl, btnText, btnUrl] = parts;
  const caption = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(desc)}`;
  // check per-post override by message prefix? For /card we support [copy]/[nocopy] in the raw title optionally
  const keyboardButtons = [];
  if (btnText && btnUrl) {
    keyboardButtons.push([{ text: btnText, url: btnUrl }]);
  }
  if (ownerSettings.defaultCopy) {
    // add copy button under the inline keyboard (separate row)
    keyboardButtons.push([ { text: '📋 Copy', copy_text: { text: `${title} - ${desc}`.slice(0,1024) } } ]);
  }
  bot.sendPhoto(CHANNEL_ID, imageUrl, { caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardButtons } })
    .then(() => bot.sendMessage(msg.chat.id, '✅ Card posted.'))
    .catch(err => {
      console.error('card error:', err?.response?.body || err.message || err);
      bot.sendMessage(msg.chat.id, '❌ Error posting card. Check IMAGE_URL and bot perms.');
    });
});

/*
CTA format:
/cta Title | Button1Text | Button1URL | Button2Text | Button2URL
*/
bot.onText(/^\/cta\s+([\s\S]+)/, (msg, match) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Only owner.');
  const parts = match[1].trim().split('|').map(p => p.trim());
  if (parts.length < 3) return bot.sendMessage(msg.chat.id, 'Format: Title | Btn1Text | Btn1URL | Btn2Text(optional) | Btn2URL(optional)');
  const [title, b1t, b1u, b2t, b2u] = parts;
  const caption = `<b>${escapeHtml(title)}</b>`;
  const buttons = [];
  if (b1t && b1u) buttons.push({ text: b1t, url: b1u });
  if (b2t && b2u) buttons.push({ text: b2t, url: b2u });
  const inline = buttons.length ? [buttons] : undefined;
  const keyboard = inline ? { inline_keyboard: [buttons] } : undefined;
  // attach copy if defaultCopy true
  if (ownerSettings.defaultCopy) {
    const copyKb = buildCopyKeyboard(title);
    // merge keyboards if both exist
    if (keyboard) {
      keyboard.inline_keyboard.push(copyKb.inline_keyboard[0]);
    } else { keyboard = copyKb; }
  }
  bot.sendMessage(CHANNEL_ID, caption, { parse_mode: 'HTML', reply_markup: keyboard })
    .then(() => bot.sendMessage(msg.chat.id, '✅ CTA posted.'))
    .catch(err => {
      console.error('cta error:', err?.response?.body || err.message || err);
      bot.sendMessage(msg.chat.id, '❌ Error posting CTA.');
    });
});

// --------------------- message handler: apply selected style ---------------------
bot.on('message', (msg) => {
  // ignore commands here
  if (msg.text && msg.text.startsWith('/')) return;
  if (!isOwner(msg)) return;

  const userId = msg.from.id;
  const session = getStyleSession(userId);
  // support per-post override prefix: [copy] or [nocopy]
  let text = msg.text ?? '';
  let override = null;
  if (/^\s*\[ ?copy ?\]/i.test(text)) { override = true; text = text.replace(/^\s*\[ ?copy ?\]/i, '').trim(); }
  if (/^\s*\[ ?no ?copy ?\]/i.test(text)) { override = false; text = text.replace(/^\s*\[ ?no ?copy ?\]/i, '').trim(); }

  if (!session || !session.awaitingText) {
    // hint
    return bot.sendMessage(msg.chat.id, 'ℹ️ Reply /send to forward a message, or choose a style command from 4-dot menu first.');
  }

  // for link mode we expect "Title | URL"
  if (session.mode === 'link') {
    const parts = text.split('|').map(p => p.trim());
    if (parts.length < 2) {
      return bot.sendMessage(msg.chat.id, 'Format: Title | https://example.com');
    }
    const [title, url] = parts;
    const urlSafe = escapeHtml(url.startsWith('http') ? url : 'https://' + url);
    const titleSafe = escapeHtml(title);
    const html = `<a href="${urlSafe}">${titleSafe}</a>`;
    const kb = (override === true) ? buildCopyKeyboard(`${title} - ${url}`) : (override === false ? undefined : (ownerSettings.defaultCopy ? buildCopyKeyboard(`${title} - ${url}`) : undefined));
    bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: kb })
      .then(() => { bot.sendMessage(msg.chat.id, '✅ Link posted.'); clearStyleSession(userId); })
      .catch(err => { console.error('link post error:', err?.response?.body || err.message || err); bot.sendMessage(msg.chat.id, '❌ Error posting link.'); });
    return;
  }

  // Build styled HTML (normal styles)
  const html = buildStyledHtml(session.mode, text, session.extra);
  if (!html) {
    return bot.sendMessage(msg.chat.id, '❌ Empty or invalid input.');
  }

  const shouldAttachCopy = (override === true) ? true : (override === false ? false : ownerSettings.defaultCopy);
  const kb = shouldAttachCopy ? buildCopyKeyboard(text) : undefined;

  bot.sendMessage(CHANNEL_ID, html, { parse_mode: 'HTML', reply_markup: kb })
    .then(() => { bot.sendMessage(msg.chat.id, '✅ Posted to channel.'); clearStyleSession(userId); })
    .catch(err => {
      console.error('styled post error:', err?.response?.body || err.message || err);
      bot.sendMessage(msg.chat.id, '❌ Error posting. Send logs.');
    });
});

// --------------------- end of file ---------------------
