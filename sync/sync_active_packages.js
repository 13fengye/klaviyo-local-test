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

    // Stage 2: serialize + match email — no awaits inside the loop
    console.log('\n🚀 Stage 2/3: Serialize + match email + derive fields');
    const readyRecords = [];
    const failedRecords = [];

    for (const item of packages) {
        const attrs = item.attributes;
        const userId = item.relationships?.user?.data?.id;
        const email = customerMap[userId];

        if (!email) {
            failedRecords.push({
                reason: userId ? 'email_not_matched' : 'user_not_found',
                user_id: userId ?? null,
                credit_transaction_id: item.id,
                credit_name: attrs.credit_name,
            });
            continue;
        }

        const usage = computePackageUsage(attrs);
        const expiry = attrs.expiration_datetime ?? null;

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

    // Stage 3: persist to disk
    console.log('\n🚀 Stage 3/3: Persist ready / failed records');
    fs.writeFileSync(READY_FILE, JSON.stringify(readyRecords, null, 2), 'utf-8');
    fs.writeFileSync(FAILED_FILE, JSON.stringify(failedRecords, null, 2), 'utf-8');
    console.log(`  ✅ ready: ${readyRecords.length} → ${READY_FILE}`);
    console.log(`  ✅ failed: ${failedRecords.length} → ${FAILED_FILE}`);

    const unmatched = failedRecords.filter((f) => f.reason === 'email_not_matched').length;

    console.log('\n================ Summary ================');
    console.log(`Active rows scanned   : ${scanned}`);
    console.log(`Package roots         : ${packages.length}`);
    console.log(`Matched emails        : ${readyRecords.length}`);
    console.log(`Unmatched emails      : ${unmatched}`);
    console.log(`Klaviyo ready file    : ${READY_FILE}`);
    console.log(`Failed records file   : ${FAILED_FILE}`);
    console.log('==========================================');
}

fetchAndSyncActivePackages().catch((err) => {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
});
