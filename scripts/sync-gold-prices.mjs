/**
 * Fetches CAD gold prices from xau.ca (server-side, no CORS) and writes to Firebase.
 *
 * Setup (one-time):
 * 1. Firebase Console → Project settings → Service accounts → Generate new private key
 * 2. GitHub repo → Settings → Secrets → Actions → New secret:
 *    Name: FIREBASE_SERVICE_ACCOUNT
 *    Value: paste the entire JSON key file
 * 3. Firebase Realtime Database → Rules → add read access for liveSpot (see bottom)
 * 4. Push this workflow; it runs every 5 minutes but only syncs Mon–Sat 7am–8pm Toronto time
 *    (manual "Run workflow" still works anytime for testing)
 *
 * Cost: Free on GitHub Actions. No Firebase Blaze plan required for this script.
 */

import admin from 'firebase-admin';

var METAL_PRICES_URL = 'https://www.xau.ca/apps/api/metalprices/CAD';
var DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://rafidain-co-default-rtdb.firebaseio.com';
var LIVE_SPOT_PATH = 'liveSpot';
var PRICE_HISTORY_PATH = 'priceHistory';
var KG_TO_PER_GRAM = 1000;
var BUSINESS_TZ = 'America/Toronto';

/** Mon–Sat, 7:00–19:59 in America/Toronto. */
function isBusinessHoursActive(date) {
    var d = date || new Date();
    var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: BUSINESS_TZ,
        weekday: 'short',
        hour: 'numeric',
        hour12: false
    }).formatToParts(d);
    var weekday = '';
    var hour = NaN;
    parts.forEach(function (p) {
        if (p.type === 'weekday') weekday = p.value;
        if (p.type === 'hour') hour = parseInt(p.value, 10);
    });
    // Intl may return "24" for midnight in some engines
    if (hour === 24) hour = 0;
    if (weekday === 'Sun') return false;
    return hour >= 7 && hour < 20;
}

function requireServiceAccount() {
    var raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
        throw new Error('Missing FIREBASE_SERVICE_ACCOUNT env (full service-account JSON)');
    }
    return JSON.parse(raw);
}

function apiKgToPerGram(kgStr) {
    var n = parseFloat(String(kgStr));
    if (isNaN(n)) throw new Error('Invalid kg price: ' + kgStr);
    return n / KG_TO_PER_GRAM;
}

async function fetchMetalPrices() {
    var res = await fetch(METAL_PRICES_URL, {
        headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error('xau.ca HTTP ' + res.status);
    var data = await res.json();
    var gold = data && data.prices && data.prices.gold;
    if (!gold || !gold.sell || !gold.buy || gold.sell.kg == null || gold.buy.kg == null) {
        throw new Error('Unexpected xau.ca payload');
    }
    return {
        bid: apiKgToPerGram(gold.sell.kg),
        ask: apiKgToPerGram(gold.buy.kg),
        apiUpdated: (data.rates && data.rates.lastUpdate) || null
    };
}

async function main() {
    // Cron still fires overnight; skip writes outside store hours (unless forced).
    if (process.env.FORCE_SYNC !== '1' && !isBusinessHoursActive()) {
        console.log('Outside business hours (Mon–Sat 7:00–19:59 America/Toronto) — skipping sync');
        return;
    }

    admin.initializeApp({
        credential: admin.credential.cert(requireServiceAccount()),
        databaseURL: DATABASE_URL
    });
    var db = admin.database();

    var spot = await fetchMetalPrices();
    var snapNow = Date.now();
    var livePayload = {
        t: snapNow,
        bid: spot.bid,
        ask: spot.ask,
        apiUpdated: spot.apiUpdated,
        source: 'sync-script'
    };

    await db.ref(LIVE_SPOT_PATH).set(livePayload);
    await db.ref(PRICE_HISTORY_PATH).push({
        t: snapNow,
        bid: spot.bid,
        ask: spot.ask
    });

    console.log(
        'Synced liveSpot bid=' + spot.bid.toFixed(4) +
        ' ask=' + spot.ask.toFixed(4) +
        ' apiUpdated=' + (spot.apiUpdated || 'n/a')
    );
}

main()
    .then(function () {
        // Firebase Admin leaves open sockets; force-exit so Actions finishes immediately
        process.exit(0);
    })
    .catch(function (err) {
        console.error(err);
        process.exit(1);
    });

/*
Realtime Database rules — add this node (keep your existing rules for users/offsets/etc):

  "liveSpot": {
    ".read": true,
    ".write": false
  }

  "priceHistory": {
    ".read": true,
    ".write": true,
    ".indexOn": ["t"]
  }

Writes come from this script / Cloud Functions via the Admin SDK (bypasses rules).
*/
