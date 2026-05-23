import { Telegraf, Markup } from 'telegraf';

// ---------------- CONSTANTS & STATES ----------------
const STATES = Object.freeze({
  IDLE: 'IDLE', WAIT_TEXT: 'WAIT_TEXT', WAIT_STYLE: 'WAIT_STYLE', 
  WAIT_CONFIRM: 'WAIT_CONFIRM', WAIT_RAW: 'WAIT_RAW', 
  WAIT_MEDIA: 'WAIT_MEDIA', WAIT_REPOST: 'WAIT_REPOST'
});

// ---------------- UTILITIES ----------------
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return null; }
}

function parseButtonsBlock(inputText) {
  const lines = String(inputText || '').split('\n');
  const marker = lines.findIndex(l => l.trim().toUpperCase() === 'BUTTONS:');
  if (marker === -1) return { textOnly: inputText.trim(), buttons: [] };

  const textOnly = lines.slice(0, marker).join('\n').trim();
  const buttons = [];
  
  for (const line of lines.slice(marker + 1).filter(l => l.trim())) {
    const row = line.split('||').map(b => b.trim()).filter(Boolean).map(btn => {
      const parts = btn.split('|').map(p => p.trim());
      if (parts.length >= 2 && normalizeUrl(parts[1])) {
        return Markup.button.url(parts[0].slice(0, 64), normalizeUrl(parts[1]));
      }
      return null;
    }).filter(Boolean);
    if (row.length) buttons.push(row);
  }
  return { textOnly, buttons };
}

// ---------------- STYLES ENGINE ----------------
const STYLES_LIST = [
  { id: 'normal', icon: '🔤', text: 'Normal' }, { id: 'title', icon: '🏆', text: 'Title' }, { id: 'bold', icon: '𝐁', text: 'Bold' },
  { id: 'italic', icon: '𝐼', text: 'Italic' }, { id: 'heading', icon: '🔹', text: 'Heading' }, { id: 'spoiler', icon: '🌫', text: 'Spoiler' },
  { id: 'quote', icon: '❝', text: 'Quote' }, { id: 'expand_quote', icon: '📖', text: 'Exp Quote' }, { id: 'link', icon: '🔗', text: 'Link' },
  { id: 'bullets', icon: '•', text: 'Bullets' }, { id: 'numbered', icon: '1️⃣', text: 'Numbered' }, { id: 'pros', icon: '✅', text: 'Pros' },
  { id: 'cons', icon: '❌', text: 'Cons' }, { id: 'code', icon: '💻', text: 'Code' }, { id: 'pre', icon: '🧾', text: 'Block' },
  { id: 'mono_quote', icon: '📜', text: 'Mono Qt' }, { id: 'note', icon: '📌', text: 'Note' }, { id: 'warning', icon: '⚠️', text: 'Warn' },
  { id: 'highlight', icon: '✨', text: 'Highlight' }, { id: 'center', icon: '🎯', text: 'Center' }, { id: 'strike', icon: '<s>', text: 'Strike' },
  { id: 'underline', icon: 'U', text: 'Underline' }, { id: 'divider', icon: '➖', text: 'Divider' }, { id: 'signature', icon: '✍️', text: 'Sign' }
];

function buildStyledHtml(style, text) {
  const safe = escapeHtml(text || '');
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  
  if (style === 'link') {
    const parts = (text || '').split('|').map(p => p.trim());
    return (parts.length >= 2 && normalizeUrl(parts[1])) ? `<a href="${escapeHtml(normalizeUrl(parts[1]))}">${escapeHtml(parts[0])}</a>` : safe;
  }
  
  switch (style) {
    case 'normal': return safe;
    case 'title': return `🏆 <b>${escapeHtml((text||'').toUpperCase())}</b>\n━━━━━━━━━━━━━━━━━`;
    case 'bold': return `<b>${safe}</b>`;
    case 'italic': return `<i>${safe}</i>`;
    case 'underline': return `<u>${safe}</u>`;
    case 'strike': return `<s>${safe}</s>`;
    case 'spoiler': return `<tg-spoiler>${safe}</tg-spoiler>`;
    case 'code': return `<code>${safe}</code>`;
    case 'pre': return `<pre>${safe}</pre>`;
    case 'quote': return `<blockquote>${safe}</blockquote>`;
    case 'expand_quote': return `<blockquote expandable>${safe}</blockquote>`;
    case 'heading': return `🔹 <b>${safe}</b>\n──────────────`;
    case 'bullets': return lines.map(l => `• ${escapeHtml(l)}`).join('\n');
    case 'numbered': return lines.map((l, i) => `<b>${i + 1}.</b> ${escapeHtml(l)}`).join('\n');
    case 'pros': return lines.map(l => `✅ ${escapeHtml(l)}`).join('\n');
    case 'cons': return lines.map(l => `❌ ${escapeHtml(l)}`).join('\n');
    case 'note': return `📌 <b>Note:</b> ${safe}`;
    case 'warning': return `⚠️ <b>Warning:</b> ${safe}`;
    case 'signature': return `<i>— ${safe}</i>`;
    case 'center': return `──────────────\n<b>${safe}</b>\n──────────────`;
    case 'divider': return `━━━━━━━━━━━━━━━━━━`;
    case 'highlight': return `✨ <b>${safe}</b> ✨`;
    case 'mono_quote': return `<blockquote><code>${safe}</code></blockquote>`;
    default: return safe;
  }
}

// ---------------- MENUS & KEYBOARDS ----------------
const CANCEL_INLINE = Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Action', 'cancel_action')]]);
const PERSISTENT_REPLY = Markup.keyboard([
  ['📝 Text / Multi-Block', '📎 Media / Album'],
  ['💻 Raw HTML', '🔄 Repost Msg'],
  ['🧹 Clear Screen', '❌ Cancel / Reset']
]).resize();

function getStyleMenu(session) {
  const kb = [];
  if (session.mediaId || session.mediaAlbumItems?.length > 0) {
    kb.push([Markup.button.callback('🚀 Skip Caption & Direct Post', 'action_skip_caption')]);
  }
  for (let i = 0; i < STYLES_LIST.length; i += 3) {
    const row = [];
    for(let j=0; j<3; j++) {
      if(STYLES_LIST[i+j]) row.push(Markup.button.callback(`${STYLES_LIST[i+j].icon} ${STYLES_LIST[i+j].text}`, `style_${STYLES_LIST[i+j].id}`));
    }
    kb.push(row);
  }
  kb.push([Markup.button.callback('❌ Cancel Action', 'cancel_action')]);
  return Markup.inlineKeyboard(kb);
}

function getConfirmMenu(session) {
  const kb = [
    [Markup.button.callback('✅ Publish Post', 'pub_normal'), Markup.button.callback('➕ Add Block', 'action_add_block')],
    [Markup.button.callback('🔕 Silent', 'pub_silent'), Markup.button.callback('📌 Pin', 'pub_pin'), Markup.button.callback('🔇 S+Pin', 'pub_spin')]
  ];
  if (session.draftBlocks.length > 0) kb.push([Markup.button.callback('↩️ Undo Last Block', 'action_undo_last')]);
  kb.push([Markup.button.callback('❌ Cancel Action', 'cancel_action')]);
  return Markup.inlineKeyboard(kb);
}

function renderPendingPreview(session) {
  const html = session.draftBlocks.join('\n\n');
  const btns = session.draftButtons.length ? '\n\n<i>[Buttons Attached ✅]</i>' : '';
  if (session.mediaAlbumItems && session.mediaAlbumItems.length > 0) return `🧾 <b>Album Preview (${session.mediaAlbumItems.length} items):</b>\n\n${html || '<i>No caption</i>'}${btns}`;
  if (session.mediaId) return `🧾 <b>Media Preview:</b>\n\n${html || '<i>No caption</i>'}${btns}`;
  return `🧾 <b>Post Preview:</b>\n\n──────────────\n${html || '<i>Empty</i>'}\n──────────────${btns}`;
}

// ---------------- MAIN WORKER LOGIC ----------------
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Channel Manager Pro is Online!', { status: 200 });

    try {
      const bot = new Telegraf(env.BOT_TOKEN);
      const OWNER_IDS = (env.OWNER_IDS || env.OWNER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
      const CHANNEL_ID = env.CHANNEL_ID;
      const GHOST_MODE = String(env.GHOST_MODE ?? 'true').toLowerCase() === 'true';

      // 1. Session & Auth Middleware
      bot.use(async (ctx, next) => {
        // শুধুমাত্র প্রাইভেট চ্যাট এবং অথরাইজড ইউজারকে অ্যালাউ করবো
        if (ctx.chat?.type !== 'private') return;
        const uid = String(ctx.from?.id);
        if (!uid || !OWNER_IDS.includes(uid)) return;

        const kvKey = `session_${uid}`;
        let session = await env.SESSION_KV.get(kvKey, 'json');
        
        if (!session) {
          session = {
            state: STATES.IDLE, tempRawText: null, postType: 'text',
            mediaId: null, mediaAlbumItems: [], draftBlocks: [],
            draftButtons: [], lastBotMsgId: null
          };
        }
        
        ctx.session = session;
        ctx.saveSession = async () => await env.SESSION_KV.put(kvKey, JSON.stringify(ctx.session));
        
        ctx.resetSession = async (keepLastMsg = true) => {
          const lastMsg = ctx.session.lastBotMsgId;
          ctx.session = {
            state: STATES.IDLE, tempRawText: null, postType: 'text',
            mediaId: null, mediaAlbumItems: [], draftBlocks: [],
            draftButtons: [], lastBotMsgId: keepLastMsg ? lastMsg : null
          };
          await ctx.saveSession();
        };

        ctx.safeDelete = async (msgId) => {
          if (!msgId) return;
          try { await ctx.telegram.deleteMessage(ctx.chat.id, msgId); } catch (_) {}
        };

        // Ghost Mode (ইউজারের পাঠানো মেসেজ সাথে সাথে মুছে দেওয়া)
        if (ctx.message && GHOST_MODE) await ctx.safeDelete(ctx.message.message_id);

        // Smart UI Updater
        ctx.updateUI = async (text, markupType = 'inline', customInlineKb = null) => {
          await ctx.sendChatAction('typing').catch(() => {});
          const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
          
          if (markupType === 'reply') extra.reply_markup = PERSISTENT_REPLY.reply_markup;
          else if (markupType === 'inline' && customInlineKb) extra.reply_markup = customInlineKb.reply_markup;

          if (ctx.session.lastBotMsgId) {
            try {
              await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.lastBotMsgId, undefined, text, extra);
              return;
            } catch (e) {
              // মেসেজ সেইম হলে ইগনোর করবে, নাহলে ফলব্যাক হিসেবে নতুন মেসেজ পাঠাবে
              if (e.description && e.description.includes('exactly the same')) return;
            }
          }

          // যদি এডিট করা না যায় (মেসেজ ডিলিট হয়ে থাকলে), পুরনোটা ক্লিয়ার করে নতুন পাঠাবে
          await ctx.safeDelete(ctx.session.lastBotMsgId);
          try {
            const sent = await ctx.reply(text, extra);
            ctx.session.lastBotMsgId = sent.message_id;
            await ctx.saveSession();
          } catch (err) { console.error('UI Update Error:', err); }
        };

        await next();
        
        // সব কাজ শেষে সেশন সেভ করা
        await ctx.saveSession();
      });

      // ---------------- PUBLISHING LOGIC ----------------
      const executePublish = async (ctx, opts) => {
        const html = ctx.session.draftBlocks.join('\n\n');
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: opts.silent };
        const textExtra = { ...extra };
        
        if (ctx.session.draftButtons.length > 0) {
          extra.reply_markup = { inline_keyboard: ctx.session.draftButtons };
          textExtra.reply_markup = { inline_keyboard: ctx.session.draftButtons };
        }
        
        let sentMsg;

        if (ctx.session.postType === 'text') {
          // Text Post
          if (html.length <= 4096) {
            sentMsg = await ctx.telegram.sendMessage(CHANNEL_ID, html, extra);
          } else {
            const parts = html.split(/\n{2,}/g).filter(Boolean);
            for (let i = 0; i < parts.length; i++) {
              const currentExtra = i !== parts.length - 1 ? { ...extra, reply_markup: undefined } : extra;
              sentMsg = await ctx.telegram.sendMessage(CHANNEL_ID, parts[i], currentExtra);
            }
          }
        } else if (ctx.session.postType === 'album') {
          // Album Post
          const mediaPayload = ctx.session.mediaAlbumItems.map((it, idx) => ({
            type: it.type, media: it.media,
            ...(idx === 0 && html && !ctx.session.draftButtons.length && html.length <= 1024 ? { caption: html, parse_mode: 'HTML' } : {})
          }));
          
          const msgs = await ctx.telegram.sendMediaGroup(CHANNEL_ID, mediaPayload, { disable_notification: opts.silent });
          sentMsg = msgs[0];
          
          // যদি বাটন্স থাকে অথবা ক্যাপশন অনেক বড় হয়, তাহলে টেক্সট আলাদা পাঠাবে
          if (ctx.session.draftButtons.length || (html && html.length > 1024)) {
            await ctx.telegram.sendMessage(CHANNEL_ID, html || '🔗 Links:', textExtra);
          }
        } else {
          // Single Media Post
          let hasSeparateText = false;
          if (html && !['sticker', 'video_note'].includes(ctx.session.postType)) {
            if (html.length > 1024) { 
              extra.caption = ''; 
              hasSeparateText = true; 
            } else {
              extra.caption = html;
            }
          }

          const mId = ctx.session.mediaId;
          const pt = ctx.session.postType;
          
          if (pt === 'photo') sentMsg = await ctx.telegram.sendPhoto(CHANNEL_ID, mId, extra);
          else if (pt === 'video') sentMsg = await ctx.telegram.sendVideo(CHANNEL_ID, mId, extra);
          else if (pt === 'document') sentMsg = await ctx.telegram.sendDocument(CHANNEL_ID, mId, extra);
          else if (pt === 'audio') sentMsg = await ctx.telegram.sendAudio(CHANNEL_ID, mId, extra);
          else if (pt === 'voice') sentMsg = await ctx.telegram.sendVoice(CHANNEL_ID, mId, extra);
          else if (pt === 'animation') sentMsg = await ctx.telegram.sendAnimation(CHANNEL_ID, mId, extra);
          else if (pt === 'sticker') sentMsg = await ctx.telegram.sendSticker(CHANNEL_ID, mId, extra);

          if (hasSeparateText) {
             await ctx.telegram.sendMessage(CHANNEL_ID, html, textExtra);
          }
        }
        
        if (opts.pin && sentMsg) await ctx.telegram.pinChatMessage(CHANNEL_ID, sentMsg.message_id, { disable_notification: opts.silent });
      };

      // ---------------- MESSAGE HANDLERS ----------------
      bot.on('message', async (ctx) => {
        const msg = ctx.message;
        const text = msg.text || msg.caption || '';
        const session = ctx.session;

        // Reset / Clear
        if (text === '/start' || text === '❌ Cancel / Reset') {
          await ctx.resetSession(true);
          return ctx.updateUI(`👑 <b>Channel Manager Pro</b>\n━━━━━━━━━━━━━━━━━━━━\n✨ <i>Bot is Active & Ready!</i>\n👇 নিচের বাটনগুলো ব্যবহার করে কাজ শুরু করুন।`, 'reply');
        }
        if (text === '🧹 Clear Screen') {
          await ctx.safeDelete(session.lastBotMsgId);
          await ctx.resetSession(false);
          return;
        }

        // Menus
        if (text === '📝 Text / Multi-Block') {
          await ctx.resetSession(true);
          session.state = STATES.WAIT_TEXT;
          return ctx.updateUI(`📝 <b>Text Builder:</b>\n\nআপনার টেক্সট সেন্ড করুন:\n<i>(বাটন দিতে চাইলে সবার নিচে <code>BUTTONS:</code> দিয়ে <code>Name | Link</code> লিখবেন)</i>`, 'inline', CANCEL_INLINE);
        }
        if (text === '📎 Media / Album') {
          await ctx.resetSession(true);
          session.state = STATES.WAIT_MEDIA;
          return ctx.updateUI(`📎 <b>Media Builder:</b>\n\nযেকোনো ছবি, ভিডিও বা অ্যালবাম সেন্ড করুন:`, 'inline', CANCEL_INLINE);
        }
        if (text === '💻 Raw HTML') {
          await ctx.resetSession(true);
          session.state = STATES.WAIT_RAW;
          return ctx.updateUI(`💻 <b>Raw HTML Mode:</b>\n\nসরাসরি আপনার HTML কোড সেন্ড করুন:`, 'inline', CANCEL_INLINE);
        }
        if (text === '🔄 Repost Msg') {
          await ctx.resetSession(true);
          session.state = STATES.WAIT_REPOST;
          return ctx.updateUI(`🔄 <b>Repost Mode:</b>\n\nযে মেসেজটি চ্যানেলে দিতে চান সেটি এখানে Forward করুন:`, 'inline', CANCEL_INLINE);
        }

        // Repost Handling
        if (session.state === STATES.WAIT_REPOST || (session.state === STATES.IDLE && (msg.forward_from || msg.forward_from_chat || msg.forward_origin || msg.forward_date))) {
          try {
            await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, msg.message_id);
            await ctx.resetSession(true);
            return ctx.updateUI(`✅ <b>Successfully Reposted!</b>\n\n<i>নিচের মেনু থেকে নতুন কাজ শুরু করুন।</i>`, 'reply');
          } catch { 
            return ctx.updateUI(`❌ <b>Failed:</b> Protected content or invalid forward.`, 'inline', CANCEL_INLINE); 
          }
        }

        // Media Handling
        const isMedia = msg.photo || msg.video || msg.document || msg.audio || msg.voice || msg.animation || msg.sticker;
        if ([STATES.IDLE, STATES.WAIT_MEDIA].includes(session.state) && isMedia) {
          
          if (msg.media_group_id || session.mediaAlbumItems.length > 0 || msg.photo) {
             // Cloudflare Worker Workaround for Albums
             const type = msg.photo ? 'photo' : msg.video ? 'video' : 'document';
             const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : (msg.video?.file_id || msg.document?.file_id);
             
             if (!session.mediaAlbumItems) session.mediaAlbumItems = [];
             session.mediaAlbumItems.push({ type, media: fileId });
             
             session.postType = session.mediaAlbumItems.length > 1 ? 'album' : type;
             session.mediaId = fileId; // Single id fallback
             session.state = STATES.WAIT_TEXT;
             
             return ctx.updateUI(`✅ <b>Media Added! (Total Items: ${session.mediaAlbumItems.length})</b>\n\nঅ্যালবাম তৈরি করতে পরের ছবি/ভিডিওগুলো পাঠাতে থাকুন। সব পাঠানো শেষ হলে নিচে ক্যাপশন টেক্সট দিন অথবা 'Skip Caption' বাটনে চাপুন:`, 'inline', getStyleMenu(session));
          } else {
            // Single Audio, Voice, Sticker etc.
            session.mediaId = msg.document?.file_id || msg.audio?.file_id || msg.voice?.file_id || msg.animation?.file_id || msg.sticker?.file_id;
            session.postType = msg.document ? 'document' : msg.audio ? 'audio' : msg.voice ? 'voice' : msg.animation ? 'animation' : 'sticker';
            session.state = ['sticker', 'video_note'].includes(session.postType) ? STATES.WAIT_CONFIRM : STATES.WAIT_TEXT;
            
            if (session.state === STATES.WAIT_CONFIRM) return ctx.updateUI(renderPendingPreview(session), 'inline', getConfirmMenu(session));
            return ctx.updateUI(`✅ <b>Media Detected!</b>\n\nক্যাপশন টেক্সট সেন্ড করুন অথবা স্কিপ করতে বাটনে চাপুন:`, 'inline', getStyleMenu(session));
          }
        }

        // Text Handling
        if (!text.trim()) return;

        const { textOnly, buttons } = parseButtonsBlock(text);
        if (buttons.length > 0) session.draftButtons = buttons;

        if (session.state === STATES.WAIT_RAW) {
          session.draftBlocks.push(textOnly);
          session.state = STATES.WAIT_CONFIRM;
          return ctx.updateUI(renderPendingPreview(session), 'inline', getConfirmMenu(session));
        }

        if (session.state === STATES.IDLE || session.state === STATES.WAIT_TEXT) {
          session.tempRawText = textOnly;
          session.state = STATES.WAIT_STYLE;
          return ctx.updateUI(`🎨 <b>Select Style:</b>\n\nটেক্সটটির জন্য স্টাইল নির্বাচন করুন:`, 'inline', getStyleMenu(session));
        }
      });

      // ---------------- CALLBACK QUERIES ----------------
      bot.on('callback_query', async (ctx) => {
        await ctx.answerCbQuery().catch(()=>{});
        const data = ctx.callbackQuery.data;
        const session = ctx.session;

        if (data === 'cancel_action') {
          await ctx.resetSession(true);
          return ctx.updateUI(`👑 <b>Channel Manager Pro</b>\n━━━━━━━━━━━━━━━━━━━━\n✨ <i>Action Cancelled.</i>\n👇 নিচের মেনু বাটন থেকে আবার কাজ শুরু করুন।`, 'reply');
        }

        if (data.startsWith('pub_')) {
          const isSilent = data.includes('silent') || data === 'pub_spin';
          const isPin = data.includes('pin') || data === 'pub_spin';
          
          await ctx.updateUI(`⏳ <b>Publishing to Channel...</b>`);
          try {
            await executePublish(ctx, { silent: isSilent, pin: isPin });
            await ctx.resetSession(true);
            return ctx.updateUI(`✅ <b>Successfully Published!</b>\n\n<i>নিচের মেনু থেকে নতুন কাজ শুরু করুন।</i>`, 'reply');
          } catch (e) {
            return ctx.updateUI(`❌ <b>Failed:</b> ${e.message}`, 'inline', CANCEL_INLINE);
          }
        }

        if (data === 'action_add_block') {
          session.state = STATES.WAIT_TEXT;
          return ctx.updateUI(`✏️ <b>Next Block:</b>\n\nটেক্সট সেন্ড করুন:`, 'inline', CANCEL_INLINE);
        }

        if (data.startsWith('style_')) {
          const styleId = data.replace('style_', '');
          session.draftBlocks.push(buildStyledHtml(styleId, session.tempRawText));
          session.state = STATES.WAIT_CONFIRM;
          return ctx.updateUI(renderPendingPreview(session), 'inline', getConfirmMenu(session));
        }

        if (data === 'action_undo_last') {
          session.draftBlocks.pop();
          if (!session.draftBlocks.length) session.draftButtons = [];
          
          // যদি সব ডিলিট হয়ে যায় এবং কোন মিডিয়া না থাকে
          if (!session.draftBlocks.length && !session.mediaId && session.mediaAlbumItems.length === 0) {
            await ctx.resetSession(true);
            return ctx.updateUI(`🧹 Draft Cleared.`, 'reply');
          }
          return ctx.updateUI(renderPendingPreview(session), 'inline', getConfirmMenu(session));
        }

        if (data === 'action_skip_caption') {
          session.state = STATES.WAIT_CONFIRM;
          return ctx.updateUI(renderPendingPreview(session), 'inline', getConfirmMenu(session));
        }
      });

      // Execute Telegraf Update Process
      const update = await request.json();
      await bot.handleUpdate(update);
      return new Response('OK', { status: 200 });

    } catch (error) {
      console.error('Worker Error:', error);
      // Cloudflare এ 500 error দিলে টেলিগ্রাম বারবার রি-ট্রাই করে, তাই 200 দেয়াই সেফ
      return new Response('OK', { status: 200 });
    }
  }
};
