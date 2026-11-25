import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// ================= Configuration =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.MT_API_ENDPOINT?.replace(/\/+$/, '');
const API_TOKEN = process.env.MT_ADMIN_TOKEN;
const MT_HEADERS = {
    Authorization: `Bearer ${API_TOKEN}`,
    Accept: 'application/vnd.api+json',
};

const CSV_FILE = path.join(__dirname, 'report-membership-details.csv');
const MAP_FILE = path.join(__dirname, 'customer_map.json');
const PACKAGE_CSV_FILE = path.join(__dirname, 'report-outstanding-credits.csv');
const PACKAGE_MAP_FILE = path.join(__dirname, 'package_customer_map.json');
// Separate output files so we never clobber the membership sync results
const READY_FILE = path.join(__dirname, 'ready_packages.json');
const FAILED_FILE = path.join(__dirname, 'failed_packages.json');

const PAGE_SIZE = 200;           // MT API per_page hard limit for credit_transactions
const PAGE_THROTTLE_MS = 200;
const PAGES_PER_COOLDOWN = 5;    // process this many pages per batch
const COOLDOWN_MS = 3000;        // cooldown length between batches
const USER_CONCURRENCY = 10;     // /users/{id} fallback parallelism
const MAX_FETCH_RETRIES = 4;     // network / 5xx retries with backoff
const NOW_MS = Date.now();        // fixed "now" for consistency within a single run

// ================= Klaviyo sync =================
const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const KLAVIYO_DATA_SOURCE_ID = process.env.KLAVIYO_DATA_SOURCE_ID || '01K1G5JPFAVHJ5BP1SWEEE82RH';
const KLAVIYO_BASE_URL = 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2026-07-15';
const KLAVIYO_BATCH_SIZE = 500;
const KLAVIYO_HEADERS = {
    accept: 'application/vnd.api+json',
    revision: KLAVIYO_REVISION,
    'content-type': 'application/vnd.api+json',
    Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
};

// Convert local ready records into Klaviyo data-source-record shape.
function buildKlaviyoRecords(readyRecords) {
    return readyRecords.map(({ user_email, ...object_record }) => ({
        type: 'data-source-record',
        attributes: {
            record: {
                object_record,
                relationships: {
                    email: [{ id: user_email, email: user_email }],
                },
            },
        },
    }));
}

// POST to Klaviyo with 429 backoff. On 429 it reads "Expected available in
// N seconds" (or Retry-After header) and waits that long + buffer before
// retrying. Other errors are thrown immediately.
async function klaviyoPost(url, payload) {
    const max429Retries = 10;
    let attempt = 0;
    while (true) {
        const res = await fetch(url, {
            method: 'POST',
            headers: KLAVIYO_HEADERS,
            body: JSON.stringify(payload),
        });
        if (res.ok) return res;
        const body = await res.text().catch(() => '');
        if (res.status === 429 && attempt < max429Retries) {
            const retryAfter = res.headers.get('retry-after');
            const match = body.match(/Expected available in (\d+) seconds/i);
            const waitSec = retryAfter
                ? parseInt(retryAfter, 10)
                : (match ? parseInt(match[1], 10) : 10);
            const waitMs = (waitSec + 2) * 1000;  // +2s buffer
            attempt++;
            console.warn(`  ⏳ Klaviyo 429 throttled, waiting ${waitSec + 2}s before retry (attempt ${attempt}/${max429Retries})`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
        }
        throw new Error(`Klaviyo bulk-create [${res.status}]: ${body.slice(0, 400)}`);
    }
}

async function syncToKlaviyo(readyRecords) {
    if (!KLAVIYO_API_KEY) {
        console.warn('  ⚠️ KLAVIYO_PRIVATE_API_KEY not set, skipping Klaviyo sync');
        return 0;
    }
    if (readyRecords.length === 0) return 0;

    const records = buildKlaviyoRecords(readyRecords);
    let synced = 0;
    for (let i = 0; i < records.length; i += KLAVIYO_BATCH_SIZE) {
        const batch = records.slice(i, i + KLAVIYO_BATCH_SIZE);
        const payload = {
            data: {
                type: 'data-source-record-bulk-create-job',
                attributes: { 'data-source-records': { data: batch } },
                relationships: {
                    'data-source': { data: { type: 'data-source', id: KLAVIYO_DATA_SOURCE_ID } },
                },
            },
        };
        const res = await klaviyoPost(`${KLAVIYO_BASE_URL}/data-source-record-bulk-create-jobs`, payload);
        // klaviyoPost throws on non-429 errors; reaching here means success.
        synced += batch.length;
        console.log(`  ✅ Klaviyo upserted ${synced}/${records.length}`);
        if (i + KLAVIYO_BATCH_SIZE < records.length) {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    return synced;
}

// ================= MT API helpers =================
// Strip trailing slashes from the path segment: production MT treats
// /resource/ and /resource as different routes (404), sandbox is lenient.
function canonicalizeQuery(queryPath) {
    const [pathPart, rest = ''] = queryPath.split('?');
    const normalizedPath = pathPart.replace(/\/+$/, '');
    return rest ? `${normalizedPath}?${rest}` : normalizedPath;
}

// Global throttle: when ANY worker gets a 429, all MT fetches pause until
// this timestamp. Prevents an avalanche of parallel retries from keeping
// the rate-limit window permanently open (which makes MT's penalty grow
// exponentially: 2s → 8s → 16s → 32s → ...).
let mtThrottleUntil = 0;
async function waitForMtThrottle() {
    const now = Date.now();
    if (now < mtThrottleUntil) {
        await new Promise((r) => setTimeout(r, mtThrottleUntil - now));
    }
}

async function mtFetch(queryPath) {
    const url = `${BASE_URL}${canonicalizeQuery(queryPath)}`;
    let attempt = 0;
    while (true) {
        // Respect any active global throttle before sending
        await waitForMtThrottle();
        try {
            const res = await fetch(url, { headers: MT_HEADERS });
            if (res.ok) return res.json();
            const detail = await res.text().catch(() => '(no response body)');

            // 429 throttled — wait the hinted duration and retry.
            // Does NOT consume MAX_FETCH_RETRIES budget. Sets the global
            // throttle so all concurrent workers pause together.
            if (res.status === 429) {
                const retryAfter = res.headers.get('retry-after');
                const match = detail.match(/Expected available in (\d+) seconds/i);
                const waitSec = retryAfter
                    ? parseInt(retryAfter, 10)
                    : (match ? parseInt(match[1], 10) : 60);
                const waitMs = (waitSec + 5) * 1000;  // +5s buffer
                mtThrottleUntil = Date.now() + waitMs;
                console.warn(`  ⏳ 429 throttled, ALL workers pausing ${waitSec + 5}s (until ${new Date(mtThrottleUntil).toLocaleTimeString()}) — ${url}`);
                await waitForMtThrottle();
                continue;
            }

            // 5xx are transient → retry; other 4xx are client errors → fail fast
            if (res.status >= 500 && attempt < MAX_FETCH_RETRIES) throw new Error(`HTTP ${res.status}`);
            throw new Error(`MT API [${res.status}] ${url}: ${detail.slice(0, 300)}`);
        } catch (e) {
            attempt++;
            if (attempt > MAX_FETCH_RETRIES) throw e;
            const wait = 2 ** attempt * 500;
            console.warn(`  ⚠️ fetch failed (${e.message}), retrying in ${wait}ms (attempt ${attempt}/${MAX_FETCH_RETRIES})`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
}

// ================= CSV → email map =================
function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) { values.push(current.trim().replace(/^"|"$/g, '')); current = ''; }
        else current += char;
    }
    values.push(current.trim().replace(/^"|"$/g, ''));
    return values;
}

async function loadOrGenerateCustomerMap() {
    if (fs.existsSync(MAP_FILE)) {
        console.log(`[init] Loading existing cache: ${MAP_FILE}`);
        return JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
    }

    console.log(`[init] Generating map from CSV: ${CSV_FILE}`);
    const rl = readline.createInterface({ input: fs.createReadStream(CSV_FILE, { encoding: 'utf-8' }), crlfDelay: Infinity });
    const map = {};
    let idIdx = -1, emailIdx = -1;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const cols = parseCsvLine(line);
        if (idIdx === -1) {
            idIdx = cols.indexOf('Customer ID');
            emailIdx = cols.indexOf('Customer Email');
            continue;
        }
        const id = cols[idIdx]?.trim();
        const email = cols[emailIdx]?.trim().toLowerCase();
        if (id && email?.includes('@')) map[id] = email;
    }

    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf-8');
    console.log(`[init] Map cached to ${MAP_FILE} with ${Object.keys(map).length} users`);
    return map;
}

// Email map keyed by MT Customer ID, sourced from the outstanding-credits
// report (covers package holders, including non-members).
async function loadOrGeneratePackageEmailMap() {
    if (fs.existsSync(PACKAGE_MAP_FILE)) {
        console.log(`[init] Loading existing cache: ${PACKAGE_MAP_FILE}`);
        return JSON.parse(fs.readFileSync(PACKAGE_MAP_FILE, 'utf-8'));
    }

    console.log(`[init] Generating package email map from CSV: ${PACKAGE_CSV_FILE}`);
    const rl = readline.createInterface({ input: fs.createReadStream(PACKAGE_CSV_FILE, { encoding: 'utf-8' }), crlfDelay: Infinity });
    const map = {};
    let idIdx = -1, emailIdx = -1;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const cols = parseCsvLine(line);
        if (idIdx === -1) {
            idIdx = cols.indexOf('Customer ID');
            emailIdx = cols.indexOf('Customer Email');
            continue;
        }
        const id = cols[idIdx]?.trim();
        const email = cols[emailIdx]?.trim().toLowerCase();
        if (id && email?.includes('@')) map[id] = email;
    }

    fs.writeFileSync(PACKAGE_MAP_FILE, JSON.stringify(map, null, 2), 'utf-8');
    console.log(`[init] Map cached to ${PACKAGE_MAP_FILE} with ${Object.keys(map).length} users`);
    return map;
}

// ================= Usage helpers =================
// A package is a parent credit_transaction: transaction_amount = credits granted,
// remaining_credits_cache = credits left. Mirror handler_dev.getPackageCustomProperties.
function computePackageUsage(attrs) {
    const total = attrs.transaction_amount ?? 0;
    const remaining = attrs.remaining_credits_cache ?? 0;
    const used = Math.max(0, total - remaining);
    return {
        total,
        remaining,
        used,
        pct: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
    };
}

// ================= Main pipeline =================
// Process credit_transactions in batches of PAGES_PER_COOLDOWN pages. Each
// batch runs the FULL loop (fetch pages → serialize + match email → MT
// /users/{id} fallback for misses → sync to Klaviyo) before the next batch,
// with a cooldown in between. Already-synced batches persist on disk and in
// Klaviyo even if a later batch fails.
async function fetchAndSyncActivePackages() {
    const customerMap = await loadOrGeneratePackageEmailMap();
    const listBase = `/credit_transactions?page_size=${PAGE_SIZE}&active=true`;

    // Build a ready record from a package (parent credit_transaction).
    // Returns null for expired packages so the caller can skip them.
    function buildPackageRecord(item, email) {
        const attrs = item.attributes;
        const usage = computePackageUsage(attrs);
        const expiry = attrs.expiration_datetime ?? null;
        const expired = expiry ? new Date(expiry).getTime() <= NOW_MS : false;
        if (expired) return null;
        return {
            user_email: email,
            id: item.id,
            name: attrs.credit_name,
            start_date: attrs.transaction_datetime ?? null,
            expiry_date: expiry,
            is_expired: attrs.is_expired === true,
            membership_status: 'active',
            type: 'package',
            current_cycle_end_date: expiry,
            session_usage_percentage: usage.pct,
            session_remaining: usage.remaining,
            total_sessions_included: usage.total,
            has_additional_package_purchase: false,
            is_rolling_contract: false,
        };
    }

    // Accumulators across all batches
    const allReadyRecords = [];
    const allFailedRecords = [];
    const allSkipped = [];
    let totalScanned = 0;
    let totalPackages = 0;
    let totalPages = 1;
    let klaviyoSynced = 0;
    let batchIndex = 0;

    let page = 1;
    while (page <= totalPages) {
        batchIndex++;
        let batchEndPage = Math.min(page + PAGES_PER_COOLDOWN - 1, totalPages);
        console.log(`\n🚀 Batch ${batchIndex}: pages ${page}-${batchEndPage}${totalPages > 1 ? ` of ${totalPages}` : ''}`);

        // --- 1. Fetch this batch's credit_transaction pages (keep roots only) ---
        const batchPackages = [];
        let batchScanned = 0;
        for (let p = page; p <= batchEndPage; p++) {
            const sep = listBase.includes('?') ? '&' : '?';
            const json = await mtFetch(`${listBase}${sep}page=${p}`);
            if (p === page) {
                totalPages = json.meta?.pagination?.pages ?? totalPages;
                batchEndPage = Math.min(page + PAGES_PER_COOLDOWN - 1, totalPages);
            }
            const items = json.data || [];
            const roots = items.filter((t) => t.relationships?.parent_credit_transaction?.data === null);
            batchScanned += items.length;
            batchPackages.push(...roots);
            console.log(`  [fetch] Page ${p}/${totalPages}: ${items.length} rows → ${roots.length} packages`);
            if (p < batchEndPage) await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
        }
        totalScanned += batchScanned;
        totalPackages += batchPackages.length;

        // --- 2. Serialize + match email from CSV; collect unmatched ---
        const batchReady = [];
        const unmatchedUsers = new Map();  // userId → array of package items
        for (const item of batchPackages) {
            const attrs = item.attributes;
            const userId = item.relationships?.user?.data?.id;
            const email = customerMap[userId];

            if (!email) {
                if (userId) {
                    if (!unmatchedUsers.has(userId)) unmatchedUsers.set(userId, []);
                    unmatchedUsers.get(userId).push(item);
                } else {
                    allFailedRecords.push({
                        reason: 'user_not_found',
                        user_id: null,
                        credit_transaction_id: item.id,
                        credit_name: attrs.credit_name,
                    });
                }
                continue;
            }
            const rec = buildPackageRecord(item, email);
            if (rec) batchReady.push(rec);
            else allSkipped.push({ id: item.id, reason: 'expired', expiry_date: attrs.expiration_datetime ?? null });
        }

        // --- 3. MT /users/{id} fallback for unmatched users (bounded concurrency) ---
        if (unmatchedUsers.size > 0) {
            console.log(`  🔧 CSV missed ${unmatchedUsers.size} user(s), fetching from MT /users/{id}...`);
            const uniqueIds = [...unmatchedUsers.keys()];
            const fetchedMap = new Map();
            const queue = [...uniqueIds];
            const workers = Math.min(USER_CONCURRENCY, queue.length);
            const workerFns = Array.from({ length: workers }, async () => {
                while (queue.length > 0) {
                    const uid = queue.shift();
                    try {
                        const r = await mtFetch(`/users/${uid}`);
                        const email = r?.data?.attributes?.email?.toLowerCase();
                        fetchedMap.set(uid, email?.includes('@') ? email : null);
                    } catch (e) {
                        console.warn(`    ⚠️ MT /users/${uid} failed: ${e.message}`);
                        fetchedMap.set(uid, null);
                    }
                }
            });
            await Promise.all(workerFns);

            let resolved = 0;
            for (const [uid, items] of unmatchedUsers) {
                const email = fetchedMap.get(uid);
                if (email) {
                    resolved++;
                    for (const item of items) {
                        const rec = buildPackageRecord(item, email);
                        if (rec) batchReady.push(rec);
                        else allSkipped.push({ id: item.id, reason: 'expired', expiry_date: item.attributes.expiration_datetime ?? null });
                    }
                } else {
                    for (const item of items) {
                        allFailedRecords.push({
                            reason: 'email_not_matched',
                            user_id: uid,
                            credit_transaction_id: item.id,
                            credit_name: item.attributes.credit_name,
                        });
                    }
                }
            }
            console.log(`  ✅ MT fallback resolved ${resolved}/${unmatchedUsers.size}`);
        }
        allReadyRecords.push(...batchReady);

        // --- 4. Persist incrementally + sync this batch to Klaviyo ---
        fs.writeFileSync(READY_FILE, JSON.stringify(allReadyRecords, null, 2), 'utf-8');
        fs.writeFileSync(FAILED_FILE, JSON.stringify(allFailedRecords, null, 2), 'utf-8');

        if (batchReady.length > 0) {
            try {
                klaviyoSynced += await syncToKlaviyo(batchReady);
            } catch (err) {
                console.error(`  ❌ Batch ${batchIndex} Klaviyo sync failed: ${err.message}`);
            }
        }
        console.log(`  ✅ Batch ${batchIndex} done: scanned ${batchScanned}, ${batchPackages.length} packages → ${batchReady.length} ready (synced ${klaviyoSynced} total)`);

        page = batchEndPage + 1;

        // Cooldown before the next batch (skip on the last one)
        if (page <= totalPages) {
            console.log(`  ⏳ Cooling down ${COOLDOWN_MS}ms before next batch ...`);
            await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        }
    }

    // --- Final summary ---
    const unmatched = allFailedRecords.filter((f) => f.reason === 'email_not_matched').length;
    const skippedExpired = allSkipped.filter((s) => s.reason === 'expired').length;

    console.log('\n================ Summary ================');
    console.log(`Active rows scanned   : ${totalScanned}`);
    console.log(`Package roots         : ${totalPackages}`);
    console.log(`Batches processed     : ${batchIndex}`);
    console.log(`Matched emails        : ${allReadyRecords.length}`);
    console.log(`Unmatched emails      : ${unmatched}`);
    console.log(`Skipped (expired)     : ${skippedExpired}`);
    console.log(`Klaviyo upserted      : ${klaviyoSynced}`);
    console.log(`Klaviyo ready file    : ${READY_FILE}`);
    console.log(`Failed records file   : ${FAILED_FILE}`);
    console.log('==========================================');
}

fetchAndSyncActivePackages().catch((err) => {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
});
