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
    res.status(200).send("Binance 1-Hour EMA Bot is awake!");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- 2. TELEGRAM ALERT SYSTEM ---
async function sendTelegramAlert(symbol, price, ema) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const now = Date.now();
    // 5-minute cooldown to prevent spam if price dances right on the EMA line
    if (now - lastAlertTime[symbol] < 300000) return; 

    const pairName = PAIRS[symbol];
    const msg = `🚨 *${pairName} ALERT*\n\nPrice touched the 21 EMA!\nPrice: ${price.toFixed(4)}\nEMA: ${ema.toFixed(4)}\nTimeframe: 1h`;
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
    let statusMsg = `📊 *Live Market Status (1-Hour Timeframe)*\n\n`;
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
        statusMsg = "⏳ *Bot is currently warming up!*\nGathering 1h candles. Please try again in a moment.";
    } else {
        statusMsg += `\n_Monitoring 1h timeframe 24/7..._`;
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

// Check and Announce the Last Cross on Startup
async function announceStartupCrosses() {
    let msg = `🚀 *Bot Deployed Successfully*\n_Monitoring 1-Hour Timeframe_\n\n*Last 21 EMA Touches:*\n`;
    
    for (const sym in PAIRS) {
        const symHistory = history[sym];
        let lastCross = null;
        
        // Loop backwards to find the most recent touch
        for (let i = symHistory.length - 1; i >= 0; i--) {
            const curr = symHistory[i];
            if (curr.ema && curr.low <= curr.ema && curr.high >= curr.ema) {
                lastCross = curr;
                break;
            }
        }

        if (lastCross) {
            const dateStr = new Date(lastCross.time).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
            msg += `• *${PAIRS[sym]}*: ${lastCross.ema.toFixed(4)} (on ${dateStr} IST)\n`;
        } else {
            msg += `• *${PAIRS[sym]}*: No touch in the last 100 hours\n`;
        }
    }

    console.log("\n--- STARTUP REPORT ---");
    console.log(msg.replace(/\*/g, '').replace(/_/g, '')); // Log to Render console without markdown
    console.log("----------------------\n");

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`;
        await fetch(url).catch(e => console.error("Failed to send startup Telegram message:", e));
    }
}

// Fetch 1-Hour Historical Data natively
async function fetchHistoricalData() {
    console.log("Fetching historical 1h data from Binance Vision API...");
    for (const sym of Object.keys(PAIRS)) {
        try {
            // Changed interval to '1h'
            const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&limit=${MAX_CANDLES}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            
            // Map the native 1h candles directly
            history[sym] = data.map(k => ({
                time: k[0], // Binance gives us the exact 1h bucket start time
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                alerted: false
            }));
            
            calculateAllEMA(sym);
            console.log(`Loaded ${history[sym].length} 1h candles for ${PAIRS[sym]}`);
        } catch (e) {
            console.error(`Could not fetch REST data for ${sym}...`, e.message);
            history[sym] = []; 
        }
    }
}

let ws;
function connectBinanceWS() {
    // Changed streams to 'kline_1h'
    const streams = Object.keys(PAIRS).map(sym => `${sym.toLowerCase()}@kline_1h`).join('/');
    const wsUrl = `wss://data-stream.binance.vision:9443/ws/${streams}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
        console.log("Connected to Binance Vision WebSocket. Live monitoring 1h candles.");
    });
    
    ws.on('message', (data) => {
        const payload = JSON.parse(data);
        if (payload.e === 'kline') {
            const sym = payload.s;
            if (!PAIRS[sym]) return;
            
            const k = payload.k;
            const bucket = k.t; // 1-Hour bucket time directly from Binance
            const currentPrice = parseFloat(k.c);
            const high = parseFloat(k.h);
            const low = parseFloat(k.l);
            const open = parseFloat(k.o);
            
            const symHistory = history[sym];
            
            if (symHistory.length === 0) {
                symHistory.push({ time: bucket, open, high, low, close: currentPrice, alerted: false });
                return; 
            }
            
            let lastCandle = symHistory[symHistory.length - 1];
            
            // Update the current 1-hour candle or create a new one
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
                        lastCandle.alerted = true; // Set to true so it doesn't spam within the same 1h candle
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
    await announceStartupCrosses(); // Check and send the last cross info to Telegram!
    connectBinanceWS();
}

start();
