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
const READY_FILE = path.join(__dirname, 'ready_records.json');
const FAILED_FILE = path.join(__dirname, 'failed_records.json');

const PAGE_SIZE = 200;           // MT API per_page hard limit
const PAGE_THROTTLE_MS = 200;
const PAGES_PER_COOLDOWN = 5;    // pause every N pages to stay under rate limits
const COOLDOWN_MS = 1000;        // cooldown length after N pages
const MAX_FETCH_RETRIES = 4;     // network / 5xx retries with backoff
const USER_CONCURRENCY = 10;     // Stage 2: how many users to fetch in parallel
const COMMITMENT_INTERVALS = new Set(['DY', 'WK', 'MO', 'YR']);
const SESSION_NAME_RE = /(\d+)\s*(?:Session?|Class(?:es)?)/i;
const NOW_MS = Date.now();       // Fixed "now" for consistency within a single run

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

// Convert local ready records into Klaviyo data-source-record shape:
// object_record carries the custom-object fields; relationships.Email links
// the record to the profile by email.
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

async function* paginateAll(baseQuery) {
    let page = 1;
    let totalPages = 1;
    do {
        const sep = baseQuery.includes('?') ? '&' : '?';
        const json = await mtFetch(`${baseQuery}${sep}page=${page}`);
        totalPages = json.meta?.pagination?.pages ?? totalPages;
        for (const item of json.data || []) yield item;
        page++;
        if (page <= totalPages) {
            await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
            if (page % PAGES_PER_COOLDOWN === 0) {
                console.log(`  [paginate] Cooling down ${COOLDOWN_MS}ms after page ${page - 1}/${totalPages}`);
                await new Promise((r) => setTimeout(r, COOLDOWN_MS));
            }
        }
    } while (page <= totalPages);
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

// ================= Date & usage helpers =================
function safeDate(str) {
    if (!str) return null;
    const d = new Date(typeof str === 'string' ? str.replace(' ', 'T') : str);
    return isNaN(d.getTime()) ? null : d;
}

function computeCommitmentExpiry(attrs) {
    const { commitment_length: length, payment_interval: interval, start_date: start } = attrs;
    if (!(length > 0) || !COMMITMENT_INTERVALS.has(interval)) return null;
    const date = safeDate(start);
    if (!date) return null;

    if (interval === 'DY' || interval === 'WK') {
        const days = length * (interval === 'WK' ? 7 : 1);
        date.setUTCDate(date.getUTCDate() + days);
    } else {
        const originalDay = date.getUTCDate();
        const months = length * (interval === 'YR' ? 12 : 1);
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + months);
        const lastDay = new Date(date.getTime());
        lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
        date.setUTCDate(Math.min(originalDay, lastDay.getUTCDate()));
    }
    return date.toISOString().replace(/\.000Z$/, 'Z');
}

function computeSessionUsage(attrs, tx) {
    const used = tx.usage_count ?? 0;
    const remainingRaw = tx.remaining_usage_count;
    let total;
    if (remainingRaw != null) total = used + remainingRaw;
    else if (attrs.usage_interval_limit != null) total = attrs.usage_interval_limit;
    else {
        const m = (attrs.membership_name || '').match(SESSION_NAME_RE);
        total = m ? parseInt(m[1], 10) : 31;
    }
    return {
        total,
        remaining: Math.max(0, total - used),
        pct: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
    };
}

// Compute expiry_date: prefer commitment end (if still in future);
// fall back to the current cycle end returned by MT.
function resolveExpiryDate(attrs) {
    const computed = computeCommitmentExpiry(attrs);
    if (computed && new Date(computed).getTime() > NOW_MS) return computed;
    return attrs.next_charge_date
        ?? attrs.payment_interval_end_date
        ?? null;
}

// ================= credit_transactions prefetch =================
// A membership may span many transactions; keep timestamps of positive (purchase) rows only.
async function fetchUserPackagePurchaseDates(userId) {
    if (!userId) return [];
    const dates = [];
    for await (const item of paginateAll(`/credit_transactions?user=${userId}&page_size=100`)) {
        const a = item.attributes;
        const isParent = item.relationships?.parent_credit_transaction?.data === null;
        const isPurchase = a.origination_type === 'purchase';
        if ((a.transaction_amount ?? 0) > 0 && isParent && isPurchase) dates.push(a.transaction_datetime);
    }
    return dates;
}

function hasPurchaseInCycle(purchaseDates, cycleStart, cycleEnd) {
    if (!cycleStart) return false;
    const start = cycleStart.getTime();
    const end = cycleEnd ? cycleEnd.getTime() : Infinity;
    return purchaseDates.some((dt) => {
        const t = safeDate(dt)?.getTime();
        return t != null && t >= start && t <= end;
    });
}

// ================= Main pipeline =================
// Two-phase design:
//   Phase 1: fetch ALL memberships from MT (in 5-page batches to stay under
//            rate limits), prefetch credit_transactions, serialize, and write
//            the full result to ready_records.json / failed_records.json.
//   Phase 2: read ready_records.json back and sync to Klaviyo in batches of
//            KLAVIYO_BATCH_SIZE, with 429 backoff.
// Decoupling the two means MT throttling and Klaviyo throttling don't
// interfere, and a sync failure leaves the data safely on disk.
// Pass --sync-only to skip Phase 1 and re-sync from the existing file.
async function fetchAndSyncActiveMemberships() {
    const syncOnly = process.argv.includes('--sync-only');
    const customerMap = syncOnly ? {} : await loadOrGenerateCustomerMap();
    const listBase = `/membership_instances?page_size=${PAGE_SIZE}&status=active&include=current_membership_transaction`;

    // Accumulators across all batches (Phase 1)
    const allReadyRecords = [];
    const allFailedRecords = [];
    const allSkipped = [];
    let totalMemberships = 0;
    let totalPages = 1;
    let batchIndex = 0;

    let page = 1;

    // ===== Phase 1: fetch + process ALL data, then write to disk =====
    if (!syncOnly) {
        console.log('\n🚀 Phase 1: Fetch all memberships + serialize → ready_records.json');
        while (page <= totalPages) {
            batchIndex++;
            // First page of the batch is fetched before we know totalPages, so
            // clamp the batch end after the first page responds.
            let batchEndPage = Math.min(page + PAGES_PER_COOLDOWN - 1, totalPages);

            console.log(`\n🚀 Batch ${batchIndex}: pages ${page}-${batchEndPage}${totalPages > 1 ? ` of ${totalPages}` : ''}`);

            // --- 1. Fetch this batch's membership pages ---
            const batchMemberships = [];
            const includedTxById = new Map();
            for (let p = page; p <= batchEndPage; p++) {
                const url = `${listBase}&page=${p}`;
                process.stdout.write(`  [fetch] Page ${p}/${totalPages} → ... `);
                const t0 = Date.now();
                const json = await mtFetch(url);
                // totalPages is only known after the first response
                if (p === page) {
                    totalPages = json.meta?.pagination?.pages ?? totalPages;
                    batchEndPage = Math.min(page + PAGES_PER_COOLDOWN - 1, totalPages);
                }
                const count = json.data?.length ?? 0;
                const includedCount = (json.included || []).filter((i) => i.type === 'membership_transactions').length;
                process.stdout.write(`OK (${count} memberships + ${includedCount} tx, ${Date.now() - t0}ms)\n`);
                for (const m of json.data || []) batchMemberships.push(m);
                for (const inc of json.included || []) {
                    if (inc.type === 'membership_transactions') includedTxById.set(inc.id, inc.attributes);
                }
                if (p < batchEndPage) await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
            }
            totalMemberships += batchMemberships.length;

            // --- 3. Serialize this batch ---
            // NOTE: has_additional_package_purchase is temporarily hardcoded to
            // false. Computing it requires a credit_transactions fetch per user
            // (the slowest, most 429-prone step). Re-enable step 2 below later.
            const batchReady = [];
            for (const item of batchMemberships) {
                const userId = item.relationships?.user?.data?.id;
                const email = customerMap[userId];
                const attrs = item.attributes;

                if (!email) {
                    allFailedRecords.push({
                        reason: 'email_not_matched',
                        user_id: userId,
                        membership_instance_id: item.id,
                        membership_name: attrs.membership_name,
                    });
                    continue;
                }

                const txId = item.relationships?.current_membership_transaction?.data?.id;
                const tx = includedTxById.get(txId) || {};
                const cycleStartRaw = tx.payment_interval_start_date || attrs.payment_interval_start_date;
                const cycleEndRaw = tx.payment_interval_end_date || attrs.payment_interval_end_date;
                const cycleStart = safeDate(cycleStartRaw);
                const cycleEnd = safeDate(cycleEndRaw);
                const usage = computeSessionUsage(attrs, tx);
                const hasPkg = false; // TODO: hasPurchaseInCycle(packageDatesByUser.get(userId) || [], cycleStart, cycleEnd)
                const expiryDate = resolveExpiryDate(attrs);

                // Skip expired memberships; remaining===0 is kept.
                const expired = expiryDate ? new Date(expiryDate).getTime() <= NOW_MS : false;
                if (expired) {
                    allSkipped.push({ id: item.id, reason: 'expired', expiry_date: expiryDate });
                    continue;
                }

                const commitmentLength = attrs.commitment_length ?? 0;
                const renewalCount = attrs.renewal_count ?? 0;
                const isRollingContract = commitmentLength === 0 || renewalCount > commitmentLength;

                batchReady.push({
                    user_email: email,
                    id: item.id,
                    name: attrs.membership_name,
                    start_date: attrs.start_date || attrs.calculated_start_datetime,
                    expiry_date: expiryDate,
                    is_expired: false,
                    membership_status: attrs.status,
                    type: 'membership',
                    current_cycle_end_date: cycleEndRaw || null,
                    session_usage_percentage: usage.pct,
                    session_remaining: usage.remaining,
                    total_sessions_included: usage.total,
                    has_additional_package_purchase: hasPkg,
                    is_rolling_contract: isRollingContract,
                });
            }
            allReadyRecords.push(...batchReady);

            console.log(`  ✅ Batch ${batchIndex} done: ${batchMemberships.length} memberships → ${batchReady.length} ready (total ${allReadyRecords.length})`);

            page = batchEndPage + 1;

            // Cooldown before the next batch (skip on the last one)
            if (page <= totalPages) {
                console.log(`  ⏳ Cooling down ${COOLDOWN_MS}ms before next batch ...`);
                await new Promise((r) => setTimeout(r, COOLDOWN_MS));
            }
        }

        // Persist the full result once, after all batches are processed
        fs.writeFileSync(READY_FILE, JSON.stringify(allReadyRecords, null, 2), 'utf-8');
        fs.writeFileSync(FAILED_FILE, JSON.stringify(allFailedRecords, null, 2), 'utf-8');
        console.log(`\n  ✅ Phase 1 complete: ${allReadyRecords.length} ready → ${READY_FILE}`);
        console.log(`  ✅ failed: ${allFailedRecords.length} → ${FAILED_FILE}`);
    } else {
        console.log('\n🚀 --sync-only: skipping Phase 1, will sync from existing ready_records.json');
    }

    // ===== Phase 2: read ready_records.json and sync to Klaviyo in batches =====
    console.log('\n🚀 Phase 2: Sync to Klaviyo');
    let klaviyoSynced = 0;
    try {
        const recordsToSync = JSON.parse(fs.readFileSync(READY_FILE, 'utf-8'));
        if (!Array.isArray(recordsToSync)) throw new Error(`${READY_FILE} is not a JSON array`);
        console.log(`  ${recordsToSync.length} record(s) to sync from ${READY_FILE}`);
        klaviyoSynced = await syncToKlaviyo(recordsToSync);
    } catch (err) {
        console.error('  ❌ Klaviyo sync failed:', err.message);
    }

    // --- Final summary ---
    const unmatched = allFailedRecords.filter((f) => f.reason === 'email_not_matched').length;
    const skippedExpired = allSkipped.filter((s) => s.reason === 'expired').length;

    console.log('\n================ Summary ================');
    if (!syncOnly) {
        console.log(`MT active total       : ${totalMemberships}`);
        console.log(`Batches processed     : ${batchIndex}`);
        console.log(`Matched emails        : ${allReadyRecords.length}`);
        console.log(`Unmatched emails      : ${unmatched}`);
        console.log(`Skipped (expired)     : ${skippedExpired}`);
    }
    console.log(`Klaviyo upserted      : ${klaviyoSynced}`);
    console.log(`Klaviyo ready file    : ${READY_FILE}`);
    console.log(`Failed records file   : ${FAILED_FILE}`);
    console.log('==========================================');
}

fetchAndSyncActiveMemberships().catch((err) => {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
});
