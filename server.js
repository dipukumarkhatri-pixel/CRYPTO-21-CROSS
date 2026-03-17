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
    'RENDERUSDT': 'RENDER/USDT' 
};

let history = {};
let lastAlertTime = {};
Object.keys(PAIRS).forEach(sym => {
    history[sym] = [];
    lastAlertTime[sym] = 0;
});

// --- 1. EXPRESS SERVER (For Render & CronJobs) ---
app.get('/ping', (req, res) => {
    res.status(200).send("Binance5sEmaBot is awake and monitoring 5s Binance candles!");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- 2. TELEGRAM ALERT SYSTEM ---
async function sendTelegramAlert(symbol, price, ema) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const now = Date.now();
    // 30-second cooldown to avoid spam on volatile 5s candles
    if (now - lastAlertTime[symbol] < 30000) return; 

    const pairName = PAIRS[symbol];
    const msg = `🚨 *${pairName} ALERT*\n\nPrice touched the 21 EMA!\nPrice: ${price.toFixed(4)}\nEMA: ${ema.toFixed(4)}\nTimeframe: 5s`;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`;

    try {
        await fetch(url);
        console.log(`[${new Date().toLocaleTimeString()}] Alert sent to Telegram for ${pairName}!`);
        lastAlertTime[symbol] = now;
    } catch (error) {
        console.error(`Failed to send Telegram message for ${pairName}:`, error);
    }
}

// --- 3. TELEGRAM COMMAND LISTENER (/status) ---
let lastUpdateId = 0;

async function sendStatusMessage(targetChatId) {
    let statusMsg = `📊 *Live Market Status (5s Timeframe)*\n\n`;
    let warmingUp = false;

    for (const sym in PAIRS) {
        const symHistory = history[sym];
        if (symHistory.length < PERIOD) {
            warmingUp = true;
            break;
        }
        const curr = symHistory[symHistory.length - 1];
        const trend = curr.close >= curr.ema ? "🟢 Bullish" : "🔴 Bearish";
        statusMsg += `*${PAIRS[sym]}*: ${curr.close.toFixed(4)} (EMA: ${curr.ema.toFixed(4)}) - ${trend}\n`;
    }

    if (warmingUp) {
        statusMsg = "⏳ *Bot is currently warming up!*\nGathering 5s candles. Please try again in about a minute.";
    } else {
        statusMsg += `\n_Monitoring 5s timeframe 24/7..._`;
    }
    
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${targetChatId}&text=${encodeURIComponent(statusMsg)}&parse_mode=Markdown`);
}

async function pollTelegram() {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                const message = update.message;
                
                if (message && message.text === '/status') {
                    await sendStatusMessage(message.chat.id);
                }
            }
        }
    } catch (error) {}
    pollTelegram();
}

pollTelegram();

// --- 4. TRADING LOGIC ---
function calculateAllEMA(symbol) {
    const symHistory = history[symbol];
    for (let i = 0; i < symHistory.length; i++) {
        if (i === 0) {
            symHistory[i].ema = symHistory[i].close;
        } else {
            const k = 2 / (PERIOD + 1);
            const prevEMA = symHistory[i - 1].ema;
            symHistory[i].ema = (symHistory[i].close - prevEMA) * k + prevEMA;
        }
    }
}

// Using Binance's 'data-api.binance.vision' endpoint to bypass US Server 451 errors
async function fetchHistoricalData() {
    console.log("Fetching historical 1s data from Binance Vision API to build 5s candles...");
    for (const sym of Object.keys(PAIRS)) {
        try {
            const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1s&limit=500`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            
            let aggregated = {};
            for (const k of data) {
                const t = k[0]; 
                const open = parseFloat(k[1]);
                const high = parseFloat(k[2]);
                const low = parseFloat(k[3]);
                const close = parseFloat(k[4]);
                
                const bucket = Math.floor(t / 5000) * 5000;
                
                if (!aggregated[bucket]) {
                    aggregated[bucket] = { time: bucket, open, high, low, close, alerted: false };
                } else {
                    aggregated[bucket].high = Math.max(aggregated[bucket].high, high);
                    aggregated[bucket].low = Math.min(aggregated[bucket].low, low);
                    aggregated[bucket].close = close; 
                }
            }
            
            let sortedBuckets = Object.values(aggregated).sort((a, b) => a.time - b.time);
            if (sortedBuckets.length > MAX_CANDLES) sortedBuckets = sortedBuckets.slice(-MAX_CANDLES);
            
            history[sym] = sortedBuckets;
            calculateAllEMA(sym);
            console.log(`Loaded ${history[sym].length} 5s candles for ${PAIRS[sym]}`);
        } catch (e) {
            console.error(`Could not fetch REST data for ${sym}. Building live via WebSocket...`, e.message);
            history[sym] = []; 
        }
    }
}

let ws;
function connectBinanceWS() {
    const streams = Object.keys(PAIRS).map(sym => `${sym.toLowerCase()}@kline_1s`).join('/');
    // Using 'data-stream.binance.vision' to bypass US Server 451 errors
    const wsUrl = `wss://data-stream.binance.vision:9443/ws/${streams}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
        console.log("Connected to Binance Vision WebSocket. Live monitoring 5s candles.");
    });
    
    ws.on('message', (data) => {
        const payload = JSON.parse(data);
        if (payload.e === 'kline') {
            const sym = payload.s;
            if (!PAIRS[sym]) return;
            
            const k = payload.k;
            const t = k.t; 
            const currentPrice = parseFloat(k.c);
            const high = parseFloat(k.h);
            const low = parseFloat(k.l);
            const open = parseFloat(k.o);
            
            // Mathematically group the 1s stream into exact 5s buckets
            const bucket = Math.floor(t / 5000) * 5000; 
            const symHistory = history[sym];
            
            if (symHistory.length === 0) {
                symHistory.push({ time: bucket, open, high, low, close: currentPrice, alerted: false });
                return; 
            }
            
            let lastCandle = symHistory[symHistory.length - 1];
            
            if (lastCandle.time === bucket) {
                lastCandle.high = Math.max(lastCandle.high, high);
                lastCandle.low = Math.min(lastCandle.low, low);
                lastCandle.close = currentPrice;
            } else if (bucket > lastCandle.time) {
                symHistory.push({ time: bucket, open, high, low, close: currentPrice, alerted: false });
                if (symHistory.length > MAX_CANDLES) symHistory.shift();
                lastCandle = symHistory[symHistory.length - 1];
            }
            
            // Only trigger alerts if we have enough data for a valid EMA
            if (symHistory.length >= PERIOD) {
                calculateAllEMA(sym);
                const currentEma = lastCandle.ema;
                
                if (lastCandle.low <= currentEma && lastCandle.high >= currentEma) {
                    if (!lastCandle.alerted) {
                        sendTelegramAlert(sym, currentPrice, currentEma);
                        lastCandle.alerted = true;
                    }
                }
            }
        }
    });
    
    ws.on('close', () => {
        console.log("Binance WebSocket disconnected. Reconnecting in 3s...");
        setTimeout(connectBinanceWS, 3000);
    });
    
    ws.on('error', (err) => {
        console.error("Binance WebSocket Error:", err);
    });
}

// --- BOOT UP ---
async function start() {
    await fetchHistoricalData();
    connectBinanceWS();
}

start();
