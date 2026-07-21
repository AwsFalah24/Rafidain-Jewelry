/**
 * Optional Firebase scheduled function (Blaze plan required to deploy).
 * For a free setup, use .github/workflows/sync-gold-prices.yml instead.
 *
 * Deploy (after upgrading to Blaze):
 *   npm install -g firebase-tools
 *   firebase login
 *   cd functions && npm install
 *   firebase deploy --only functions
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const METAL_PRICES_URL = 'https://www.xau.ca/apps/api/metalprices/CAD';
const LIVE_SPOT_PATH = 'liveSpot';
const PRICE_HISTORY_PATH = 'priceHistory';
const KG_TO_PER_GRAM = 1000;

function apiKgToPerGram(kgStr) {
    const n = parseFloat(String(kgStr));
    if (Number.isNaN(n)) throw new Error('Invalid kg price: ' + kgStr);
    return n / KG_TO_PER_GRAM;
}

function isBusinessHoursActive(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Toronto',
        weekday: 'short',
        hour: 'numeric',
        hour12: false
    }).formatToParts(date);
    let weekday = '';
    let hour = NaN;
    for (const p of parts) {
        if (p.type === 'weekday') weekday = p.value;
        if (p.type === 'hour') hour = parseInt(p.value, 10);
    }
    if (hour === 24) hour = 0;
    if (weekday === 'Sun') return false;
    return hour >= 7 && hour < 20;
}

async function syncGoldPrices() {
    if (!isBusinessHoursActive()) {
        logger.info('Outside business hours — skipping sync');
        return null;
    }
    const res = await fetch(METAL_PRICES_URL, {
        headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error('xau.ca HTTP ' + res.status);
    const data = await res.json();
    const gold = data && data.prices && data.prices.gold;
    if (!gold || !gold.sell || !gold.buy || gold.sell.kg == null || gold.buy.kg == null) {
        throw new Error('Unexpected xau.ca payload');
    }

    const bid = apiKgToPerGram(gold.sell.kg);
    const ask = apiKgToPerGram(gold.buy.kg);
    const apiUpdated = (data.rates && data.rates.lastUpdate) || null;
    const snapNow = Date.now();
    const db = admin.database();

    await db.ref(LIVE_SPOT_PATH).set({
        t: snapNow,
        bid,
        ask,
        apiUpdated,
        source: 'cloud-function'
    });
    await db.ref(PRICE_HISTORY_PATH).push({ t: snapNow, bid, ask });

    const cutoff30d = snapNow - (30 * 24 * 60 * 60 * 1000);
    const oldSnap = await db.ref(PRICE_HISTORY_PATH).orderByChild('t').endAt(cutoff30d).once('value');
    const updates = {};
    oldSnap.forEach((child) => {
        updates[child.key] = null;
    });
    if (Object.keys(updates).length) {
        await db.ref(PRICE_HISTORY_PATH).update(updates);
    }

    return { bid, ask, apiUpdated };
}

exports.syncGoldPrices = onSchedule(
    {
        schedule: 'every 5 minutes',
        timeZone: 'America/Toronto',
        retryCount: 2
    },
    async () => {
        const result = await syncGoldPrices();
        if (result) logger.info('Synced liveSpot', result);
    }
);
