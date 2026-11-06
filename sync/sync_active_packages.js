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
// Strip trailing slashes from the path segment: production MT treats
// /resource/ and /resource as different routes (404), sandbox is lenient.
function canonicalizeQuery(queryPath) {
    const [pathPart, rest = ''] = queryPath.split('?');
    const normalizedPath = pathPart.replace(/\/+$/, '');
    return rest ? `${normalizedPath}?${rest}` : normalizedPath;
}

async function mtFetch(queryPath) {
    const url = `${BASE_URL}${canonicalizeQuery(queryPath)}`;
    let attempt = 0;
    while (true) {
        try {
            const res = await fetch(url, { headers: MT_HEADERS });
            if (res.ok) return res.json();
            const detail = await res.text().catch(() => '(no response body)');
            // 5xx are transient → retry; 4xx are client errors → fail fast
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
        yield { page, totalPages, items: json.data || [] };
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
async function fetchAndSyncActivePackages() {
    const customerMap = await loadOrGeneratePackageEmailMap();

    // Stage 1: fetch every active credit_transaction, keep only package roots
    // (parent_credit_transaction === null), i.e. exclude per-session deduction rows.
    console.log('\n🚀 Stage 1/3: Fetch active credit_transactions');
    const packages = [];
    let scanned = 0;
    for await (const { page, totalPages, items } of paginateAll(
        `/credit_transactions?page_size=${PAGE_SIZE}&active=true`,
    )) {
        const roots = items.filter((t) => t.relationships?.parent_credit_transaction?.data === null);
        scanned += items.length;
        packages.push(...roots);
        console.log(`  [Stage 1] Page ${page}/${totalPages}: ${items.length} rows → ${roots.length} packages (total ${packages.length})`);
    }
    console.log(`  ✅ Scanned ${scanned} active rows, kept ${packages.length} package roots`);

    // Stage 2a: serialize + match email from CSV; collect unmatched user_ids
    console.log('\n🚀 Stage 2/3: Serialize + match email + derive fields');
    const readyRecords = [];
    const failedRecords = [];
    const skipped = [];
    const unmatchedUsers = new Map();  // userId → array of package items needing email

    for (const item of packages) {
        const attrs = item.attributes;
        const userId = item.relationships?.user?.data?.id;
        const email = customerMap[userId];

        if (!email) {
            if (userId) {
                // Queue for MT API fallback lookup
                if (!unmatchedUsers.has(userId)) unmatchedUsers.set(userId, []);
                unmatchedUsers.get(userId).push(item);
            } else {
                failedRecords.push({
                    reason: 'user_not_found',
                    user_id: null,
                    credit_transaction_id: item.id,
                    credit_name: attrs.credit_name,
                });
            }
            continue;
        }
        tryBuildReady(item, email);
    }

    // Stage 2b: bulk-fetch emails via MT /users/{id} for unmatched users
    if (unmatchedUsers.size > 0) {
        console.log(`  🔧 CSV missed ${unmatchedUsers.size} user(s), fetching from MT /users/{id}...`);
        const uniqueIds = [...unmatchedUsers.keys()];
        const fetched = await Promise.all(uniqueIds.map(async (uid) => {
            try {
                const r = await mtFetch(`/users/${uid}`);
                const email = r?.data?.attributes?.email?.toLowerCase();
                if (email?.includes('@')) return [uid, email];
                return [uid, null];
            } catch (e) {
                console.warn(`  ⚠️ MT /users/${uid} failed: ${e.message}`);
                return [uid, null];
            }
        }));
        const fetchedMap = new Map(fetched);
        for (const [uid, items] of unmatchedUsers) {
            const email = fetchedMap.get(uid);
            if (email) {
                for (const item of items) tryBuildReady(item, email);
            } else {
                for (const item of items) {
                    const attrs = item.attributes;
                    failedRecords.push({
                        reason: 'email_not_matched',
                        user_id: uid,
                        credit_transaction_id: item.id,
                        credit_name: attrs.credit_name,
                    });
                }
            }
        }
        console.log(`  ✅ MT fallback resolved ${[...fetchedMap.values()].filter(Boolean).length}/${unmatchedUsers.size}`);
    }

    function tryBuildReady(item, email) {
        const attrs = item.attributes;

        const usage = computePackageUsage(attrs);
        const expiry = attrs.expiration_datetime ?? null;

        // Skip records that are already expired or fully consumed — these
        // should be removed from Klaviyo rather than re-upserted.
        const expired = expiry ? new Date(expiry).getTime() <= NOW_MS : false;
        if (expired || usage.remaining === 0) {
            skipped.push({
                id: item.id,
                reason: expired ? 'expired' : 'no_sessions_remaining',
                expiry_date: expiry,
                session_remaining: usage.remaining,
            });
        }

        readyRecords.push({
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
            user_email: email,
        });
    }

    // Stage 3: persist to disk + sync to Klaviyo
    console.log('\n🚀 Stage 3/3: Persist + sync to Klaviyo');
    fs.writeFileSync(READY_FILE, JSON.stringify(readyRecords, null, 2), 'utf-8');
    fs.writeFileSync(FAILED_FILE, JSON.stringify(failedRecords, null, 2), 'utf-8');
    console.log(`  ✅ ready: ${readyRecords.length} → ${READY_FILE}`);
    console.log(`  ✅ failed: ${failedRecords.length} → ${FAILED_FILE}`);

    let klaviyoSynced = 0;
    try {
        klaviyoSynced = await syncToKlaviyo(readyRecords);
    } catch (err) {
        console.error('  ❌ Klaviyo sync failed:', err.message);
        // Keep ready_packages.json on disk for a manual retry.
    }

    const unmatched = failedRecords.filter((f) => f.reason === 'email_not_matched').length;
    const skippedExpired = skipped.filter((s) => s.reason === 'expired').length;
    const skippedEmpty = skipped.filter((s) => s.reason === 'no_sessions_remaining').length;

    console.log('\n================ Summary ================');
    console.log(`Active rows scanned   : ${scanned}`);
    console.log(`Package roots         : ${packages.length}`);
    console.log(`Matched emails        : ${readyRecords.length}`);
    console.log(`Unmatched emails      : ${unmatched}`);
    console.log(`Skipped (expired)     : ${skippedExpired}`);
    console.log(`Skipped (remaining=0) : ${skippedEmpty}`);
    console.log(`Klaviyo upserted      : ${klaviyoSynced}`);
    console.log(`Klaviyo ready file    : ${READY_FILE}`);
    console.log(`Failed records file   : ${FAILED_FILE}`);
    console.log('==========================================');
}

fetchAndSyncActivePackages().catch((err) => {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
});
