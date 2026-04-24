const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const PERIOD = 21;
const MAX_CANDLES = 100;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PAIRS = {
    'BTCUSDT': 'BTC/USDT',
    'ETHUSDT': 'ETH/USDT',
    'SOLUSDT': 'SOL/USDT',
};

let history = {};
Object.keys(PAIRS).forEach(sym => {
    history[sym] = [];
});

// --- 1. EXPRESS SERVER (Keep-Alive) ---
app.get('/ping', (req, res) => {
    res.status(200).send("Binance 1H Candle-Close Bot is active!");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- 2. TELEGRAM ALERT SYSTEM ---
async function sendTelegramAlert(symbol, price, ema, signalType) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const pairName = PAIRS[symbol];
    const timeStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    
    const msg = `🚨 *${pairName} SIGNAL*\n\n` +
                `*Signal:* ${signalType}\n` +
                `*Close Price:* ${price.toFixed(4)}\n` +
                `*21 EMA:* ${ema.toFixed(4)}\n` +
                `*Timeframe:* 1H (UTC)\n` +
                `*Time:* ${timeStr} UTC`;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`;

    try {
        await fetch(url);
        console.log(`[${timeStr}] ${signalType} Alert sent for ${pairName}`);
    } catch (error) {
        console.error(`Telegram Error:`, error);
    }
}

// --- 3. MATH LOGIC ---
function calculateAllEMA(symbol) {
    const symHistory = history[symbol];
    const k = 2 / (PERIOD + 1);

    for (let i = 0; i < symHistory.length; i++) {
        if (i === 0) {
            symHistory[i].ema = symHistory[i].close;
        } else {
            const prevEMA = symHistory[i - 1].ema;
            symHistory[i].ema = (symHistory[i].close - prevEMA) * k + prevEMA;
        }
    }
}

// --- 4. DATA FETCHING (REST) ---
async function fetchHistoricalData() {
    console.log("Fetching UTC 1h historical data...");
    for (const sym of Object.keys(PAIRS)) {
        try {
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=${MAX_CANDLES}`);
            const data = await res.json();
            
            history[sym] = data.map(k => ({
                time: k[0], 
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4])
            }));
            
            calculateAllEMA(sym);
            console.log(`Loaded ${history[sym].length} candles for ${sym}`);
        } catch (e) {
            console.error(`Error fetching data for ${sym}:`, e.message);
        }
    }
}

// --- 5. WEBSOCKET REAL-TIME MONITORING ---
function connectBinanceWS() {
    const streams = Object.keys(PAIRS).map(sym => `${sym.toLowerCase()}@kline_1h`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/ws/${streams}`;
    
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => console.log("WebSocket Connected: Monitoring 1H UTC Candle Closes."));
    
    ws.on('message', (data) => {
        const payload = JSON.parse(data);
        const sym = payload.s;
        const k = payload.k;
        const isCandleClosed = k.x; // 'x' is true when candle officially closes
        const bucketStart = k.t;
        
        const symHistory = history[sym];
        if (symHistory.length === 0) return;

        // Current live candle update
        let lastCandle = symHistory[symHistory.length - 1];

        if (lastCandle.time === bucketStart) {
            // Update current candle stats while it's still moving
            lastCandle.close = parseFloat(k.c);
            lastCandle.high = parseFloat(k.h);
            lastCandle.low = parseFloat(k.l);
        }

        // TRIGGER ON CLOSE
        if (isCandleClosed) {
            // 1. Recalculate EMA with the finalized close price
            calculateAllEMA(sym);
            
            const closedCandle = symHistory[symHistory.length - 1];
            const prevCandle = symHistory[symHistory.length - 2];

            if (prevCandle && prevCandle.ema) {
                const wasAbove = prevCandle.close > prevCandle.ema;
                const isAbove = closedCandle.close > closedCandle.ema;
                const wasBelow = prevCandle.close < prevCandle.ema;
                const isBelow = closedCandle.close < closedCandle.ema;

                // 🟢 BUY: Closed above after being below
                if (isAbove && !wasAbove) {
                    sendTelegramAlert(sym, closedCandle.close, closedCandle.ema, "BUY 🟢 (Crossed Above EMA)");
                } 
                // 🔴 SELL: Closed below after being above
                else if (isBelow && !wasBelow) {
                    sendTelegramAlert(sym, closedCandle.close, closedCandle.ema, "SELL 🔴 (Crossed Below EMA)");
                }
            }

            // 2. Prepare for the next candle (Add a placeholder for the next hour)
            // The next message from WS will update this placeholder
            const nextTime = bucketStart + 3600000;
            symHistory.push({ time: nextTime, open: closedCandle.close, high: closedCandle.close, low: closedCandle.close, close: closedCandle.close });
            if (symHistory.length > MAX_CANDLES) symHistory.shift();
        }
    });
    
    ws.on('close', () => setTimeout(connectBinanceWS, 5000));
    ws.on('error', (err) => console.error("WS Error:", err));
}

// --- 6. TELEGRAM STATUS COMMAND ---
async function pollTelegram() {
    let lastUpdateId = 0;
    setInterval(async () => {
        try {
            const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`);
            const data = await res.json();
            if (data.ok && data.result.length > 0) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id;
                    if (update.message && update.message.text === '/status') {
                        let statusMsg = "📊 *Current 1H Trends (UTC)*\n\n";
                        for (const sym in PAIRS) {
                            const h = history[sym][history[sym].length - 1];
                            const trend = h.close > h.ema ? "🟢 Bullish" : "🔴 Bearish";
                            statusMsg += `*${PAIRS[sym]}*: ${h.close.toFixed(2)} | EMA: ${h.ema.toFixed(2)} (${trend})\n`;
                        }
                        fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${update.message.chat.id}&text=${encodeURIComponent(statusMsg)}&parse_mode=Markdown`);
                    }
                }
            }
        } catch (e) {}
    }, 3000);
}

// --- BOOT ---
async function start() {
    await fetchHistoricalData();
    connectBinanceWS();
    pollTelegram();
}

start();
