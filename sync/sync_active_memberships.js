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
                    Email: [{ id: user_email, email: user_email }],
                },
            },
        },
    }));
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
        const res = await fetch(`${KLAVIYO_BASE_URL}/data-source-record-bulk-create-jobs`, {
            method: 'POST',
            headers: KLAVIYO_HEADERS,
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Klaviyo bulk-create [${res.status}]: ${body.slice(0, 400)}`);
        }
        synced += batch.length;
        console.log(`  ✅ Klaviyo upserted ${synced}/${records.length}`);
        if (i + KLAVIYO_BATCH_SIZE < records.length) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    return synced;
}

// ================= MT API helpers =================
async function mtFetch(queryPath) {
    const url = `${BASE_URL}${queryPath}`;
    const res = await fetch(url, { headers: MT_HEADERS });
    if (!res.ok) {
        const detail = await res.text().catch(() => '(no response body)');
        throw new Error(`MT API [${res.status}] ${queryPath}: ${detail}`);
    }
    return res.json();
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
        if (page <= totalPages) await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
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
async function fetchAndSyncActiveMemberships() {
    const customerMap = await loadOrGenerateCustomerMap();

    // Stage 1: fetch all active memberships with include on every page
    // (data + included in a single shot per page)
    console.log('\n🚀 Stage 1/4: Fetch all active membership_instances');
    const memberships = [];
    const includedTxById = new Map();
    const listBase = `/membership_instances?page_size=${PAGE_SIZE}&status=active&include=current_membership_transaction`;

    let page = 1;
    let totalPages = 1;
    do {
        const url = `${listBase}&page=${page}`;
        process.stdout.write(`  [Stage 1] Page ${page}${page === 1 ? '' : `/${totalPages}`} → ${url} ... `);
        const t0 = Date.now();
        const json = await mtFetch(url);
        totalPages = json.meta?.pagination?.pages ?? totalPages;
        const count = json.data?.length ?? 0;
        const includedCount = (json.included || []).filter((i) => i.type === 'membership_transactions').length;
        process.stdout.write(`OK (${count} memberships + ${includedCount} included_tx, ${Date.now() - t0}ms)\n`);
        for (const m of json.data || []) memberships.push(m);
        for (const inc of json.included || []) {
            if (inc.type === 'membership_transactions') includedTxById.set(inc.id, inc.attributes);
        }
        if (page < totalPages) await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
        page++;
    } while (page <= totalPages);
    console.log(`  ✅ Fetched ${memberships.length} active memberships, ${includedTxById.size} current_transactions`);

    // Stage 2: collect unique user_ids, prefetch credit_transactions in parallel
    console.log('\n🚀 Stage 2/4: Prefetch credit_transactions per user');
    const uniqueUserIds = [...new Set(
        memberships.map((m) => m.relationships?.user?.data?.id).filter(Boolean),
    )];
    console.log(`  ${uniqueUserIds.length} unique user(s) to query`);

    // One request per user, run in parallel; fall back to [] on failure
    const packageDatesByUser = new Map();
    let done = 0;
    const total = uniqueUserIds.length;
    console.log(`  Launching ${total} parallel credit_transactions requests ...`);
    const tStage2 = Date.now();

    const tasks = uniqueUserIds.map(async (uid) => {
        let dates = [];
        try {
            dates = await fetchUserPackagePurchaseDates(uid);
        } catch (e) {
            console.warn(`  ⚠️ Credit transactions fetch failed for User ${uid}: ${e.message}`);
        }
        packageDatesByUser.set(uid, dates);
        done++;
        if (done % 10 === 0 || done === total) {
            const pct = Math.round((done / total) * 100);
            console.log(`  [Stage 2] ${done}/${total} (${pct}%) done`);
        }
    });
    await Promise.all(tasks);
    console.log(`  ✅ All ${total} users done in ${Date.now() - tStage2}ms`);

    // Stage 3: serialize records — no in-loop awaits
    console.log('\n🚀 Stage 3/4: Serialize + match email + derive fields');
    const readyRecords = [];
    const failedRecords = [];
    const skipped = [];

    for (const item of memberships) {
        const userId = item.relationships?.user?.data?.id;
        const email = customerMap[userId];
        const attrs = item.attributes;

        if (!email) {
            failedRecords.push({
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
        const hasPkg = hasPurchaseInCycle(packageDatesByUser.get(userId) || [], cycleStart, cycleEnd);
        const expiryDate = resolveExpiryDate(attrs);

        // Skip records that are already expired or fully consumed — these
        // should be removed from Klaviyo rather than re-upserted.
        const expired = expiryDate ? new Date(expiryDate).getTime() <= NOW_MS : false;
        if (expired || usage.remaining === 0) {
            skipped.push({
                id: item.id,
                reason: expired ? 'expired' : 'no_sessions_remaining',
                expiry_date: expiryDate,
                session_remaining: usage.remaining,
            });
            continue;
        }

        readyRecords.push({
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
            has_additional_package_purchase: hasPkg
        });
    }

    // Stage 4: persist to disk + sync to Klaviyo
    console.log('\n🚀 Stage 4/4: Persist + sync to Klaviyo');
    fs.writeFileSync(READY_FILE, JSON.stringify(readyRecords, null, 2), 'utf-8');
    fs.writeFileSync(FAILED_FILE, JSON.stringify(failedRecords, null, 2), 'utf-8');
    console.log(`  ✅ ready: ${readyRecords.length} → ${READY_FILE}`);
    console.log(`  ✅ failed: ${failedRecords.length} → ${FAILED_FILE}`);

    let klaviyoSynced = 0;
    try {
        klaviyoSynced = await syncToKlaviyo(readyRecords);
    } catch (err) {
        console.error('  ❌ Klaviyo sync failed:', err.message);
        // Keep ready_records.json on disk for a manual retry.
    }

    const unmatched = failedRecords.filter((f) => f.reason === 'email_not_matched').length;
    const skippedExpired = skipped.filter((s) => s.reason === 'expired').length;
    const skippedEmpty = skipped.filter((s) => s.reason === 'no_sessions_remaining').length;

    console.log('\n================ Summary ================');
    console.log(`MT active total       : ${memberships.length}`);
    console.log(`Matched emails        : ${readyRecords.length}`);
    console.log(`Unmatched emails      : ${unmatched}`);
    console.log(`Skipped (expired)     : ${skippedExpired}`);
    console.log(`Skipped (remaining=0) : ${skippedEmpty}`);
    console.log(`Unique users          : ${uniqueUserIds.length}`);
    console.log(`Klaviyo upserted      : ${klaviyoSynced}`);
    console.log(`Klaviyo ready file    : ${READY_FILE}`);
    console.log(`Failed records file   : ${FAILED_FILE}`);
    console.log('==========================================');
}

fetchAndSyncActiveMemberships().catch((err) => {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
});
