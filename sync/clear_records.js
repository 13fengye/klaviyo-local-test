import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// ================= Configuration =================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const KLAVIYO_DATA_SOURCE_ID = process.env.KLAVIYO_DATA_SOURCE_ID || '01K1G5JPFAVHJ5BP1SWEEE82RH';
// Optional: pin the object-type id directly. If unset, we resolve it from /object-types.
const KLAVIYO_OBJECT_TYPE_ID = process.env.KLAVIYO_OBJECT_TYPE_ID;
const KLAVIYO_BASE_URL = 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2026-07-15';
const BATCH_SIZE = 500;

const HEADERS = {
    accept: 'application/vnd.api+json',
    revision: KLAVIYO_REVISION,
    'content-type': 'application/vnd.api+json',
    Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
};

// ================= Helpers =================
// The data source (used for bulk create) and the object type (used for
// list/delete) are two ids for the same custom object. Resolve the object-type
// id by listing object-types (typically there is only one).
async function resolveObjectTypeId() {
    if (KLAVIYO_OBJECT_TYPE_ID) return KLAVIYO_OBJECT_TYPE_ID;
    const res = await fetch(`${KLAVIYO_BASE_URL}/object-types`, { headers: HEADERS });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GET /object-types failed [${res.status}]: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const types = json.data || [];
    if (types.length === 0) {
        throw new Error('No object-types found in Klaviyo.');
    }
    const ot = types[0];
    console.log(`  Resolved object-type: "${ot.attributes.title}" (${ot.id})`);
    return ot.id;
}

// Paginate all object records and return their composite ids
// (format: "{object-type-id}:::{record-id}").
async function listAllRecordIds(objectTypeId) {
    const ids = [];
    let url = `${KLAVIYO_BASE_URL}/object-types/${objectTypeId}/object-records?page[size]=100`;
    let guard = 0;
    while (url && guard < 10000) {
        guard++;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`list object-records failed [${res.status}]: ${body.slice(0, 300)}`);
        }
        const json = await res.json();
        for (const item of json.data || []) ids.push(item.id);
        url = json.links?.next || null;
        if (!url) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    return ids;
}

async function deleteRecords(objectTypeId, compositeIds) {
    if (compositeIds.length === 0) {
        console.log('  No records to delete.');
        return 0;
    }
    let deleted = 0;
    for (let i = 0; i < compositeIds.length; i += BATCH_SIZE) {
        const batch = compositeIds.slice(i, i + BATCH_SIZE);
        const payload = {
            data: {
                type: 'object-record-bulk-delete-job',
                attributes: {},
                relationships: {
                    'object-records': {
                        data: batch.map((id) => ({ type: 'object-record', id })),
                    },
                },
            },
        };
        const res = await fetch(`${KLAVIYO_BASE_URL}/object-record-bulk-delete-jobs`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`delete batch failed [${res.status}]: ${body.slice(0, 400)}`);
        }
        deleted += batch.length;
        console.log(`  ✅ Deleted ${deleted}/${compositeIds.length}`);
        if (i + BATCH_SIZE < compositeIds.length) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    return deleted;
}

// ================= Main =================
async function main() {
    if (!KLAVIYO_API_KEY) {
        console.error('❌ KLAVIYO_PRIVATE_API_KEY not set in .env');
        process.exit(1);
    }

    console.log(`Data source id: ${KLAVIYO_DATA_SOURCE_ID}`);

    console.log('\n🔎 Resolving object-type id...');
    const objectTypeId = await resolveObjectTypeId();

    console.log('\n📡 Listing all object records from Klaviyo...');
    const compositeIds = await listAllRecordIds(objectTypeId);
    console.log(`  Found ${compositeIds.length} record(s) to delete.`);

    if (compositeIds.length === 0) {
        console.log('\nNothing to clear. Done.');
        return;
    }

    const confirm = process.env.YES === '1' || process.argv.includes('--yes');
    if (!confirm) {
        console.log('\nThis will DELETE all records listed above from Klaviyo.');
        console.log('Re-run with --yes (or set YES=1) to confirm.');
        return;
    }

    console.log('\n🗑️  Deleting records...');
    const deleted = await deleteRecords(objectTypeId, compositeIds);
    console.log(`\n✅ Cleared ${deleted} record(s).`);
}

main().catch((err) => {
    console.error('Unhandled error:', err.message);
    process.exitCode = 1;
});
