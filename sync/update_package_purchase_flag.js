// update_package_purchase_flag.js
//
// Read ready_records.json, find records where has_additional_package_purchase
// is true, and upsert ONLY those records to Klaviyo. Other records are left
// untouched; the matched records keep all their existing field values (from
// ready_records.json) so nothing else is overwritten — only the
// has_additional_package_purchase flag gets pushed as true.
//
// Usage:
//   node sync/update_package_purchase_flag.js
//
// Add --dry-run to print the matched record ids without calling Klaviyo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ---------------- Config ----------------
const READY_FILE = path.join(__dirname, 'ready_records.json');
const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const KLAVIYO_DATA_SOURCE_ID =
    process.env.KLAVIYO_DATA_SOURCE_ID || '01K1G5JPFAVHJ5BP1SWEEE82RH';
const KLAVIYO_BASE_URL = process.env.KLAVIYO_BASE_URL || 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2026-07-15';
const KLAVIYO_BATCH_SIZE = 500;
const KLAVIYO_HEADERS = {
    accept: 'application/vnd.api+json',
    revision: KLAVIYO_REVISION,
    'content-type': 'application/vnd.api+json',
    Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
};

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------- Helpers (kept in sync with sync_active_memberships.js) ----------------
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
            const waitMs = (waitSec + 2) * 1000;
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
        await klaviyoPost(`${KLAVIYO_BASE_URL}/data-source-record-bulk-create-jobs`, payload);
        synced += batch.length;
        console.log(`  ✅ Klaviyo upserted ${synced}/${records.length}`);
        if (i + KLAVIYO_BATCH_SIZE < records.length) {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    return synced;
}

// ---------------- Main ----------------
async function main() {
    if (!fs.existsSync(READY_FILE)) {
        console.error(`❌ ${READY_FILE} not found`);
        process.exitCode = 1;
        return;
    }

    const allRecords = JSON.parse(fs.readFileSync(READY_FILE, 'utf-8'));
    if (!Array.isArray(allRecords)) {
        console.error('❌ ready_records.json is not a JSON array');
        process.exitCode = 1;
        return;
    }

    // Only records flagged true are candidates for update. Force the flag to
    // true so it is definitely pushed; keep every other field as-is from the
    // file so nothing else changes on Klaviyo.
    const targets = allRecords
        .filter((r) => r.has_additional_package_purchase === true)
        .map((r) => ({ ...r, has_additional_package_purchase: true }));

    console.log(`📄 ${READY_FILE}: ${allRecords.length} total, ${targets.length} with has_additional_package_purchase=true`);

    if (targets.length === 0) {
        console.log('✅ Nothing to update.');
        return;
    }

    if (DRY_RUN) {
        console.log('🔍 --dry-run: matched ids:');
        for (const r of targets) {
            console.log(`   - ${r.id}  (${r.user_email})  name=${r.name}`);
        }
        console.log(`\n${targets.length} record(s) would be updated. Re-run without --dry-run to push.`);
        return;
    }

    console.log(`🚀 Updating ${targets.length} record(s) on Klaviyo (only has_additional_package_purchase=true ones)...`);
    const synced = await syncToKlaviyo(targets);
    console.log(`\n✅ Done. ${synced}/${targets.length} record(s) updated on Klaviyo.`);
}

main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
});
