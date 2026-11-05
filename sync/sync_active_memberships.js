import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// 导入你的 Klaviyo SDK 实例（按实际路径调整）
// import { klaviyoApi } from '../utils/klaviyo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_FILE = path.join(__dirname, 'report-membership-details.csv');
const MAP_FILE = path.join(__dirname, 'customer_map.json');

// ================= 配置区域 =================
const BASE_URL = process.env.MARIANA_TEK_BASE_URL || 'https://your-domain.marianatek.com/api';
const API_TOKEN = process.env.MARIANA_TEK_TOKEN || 'YOUR_MARIANA_TEK_API_TOKEN';
// ============================================

// 1. CSV 解析函数
function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            values.push(current.trim().replace(/^"|"$/g, ''));
            current = '';
        } else {
            current += char;
        }
    }
    values.push(current.trim().replace(/^"|"$/g, ''));
    return values;
}

// 2. 加载或生成 Customer 映射字典
async function loadOrGenerateCustomerMap() {
    if (fs.existsSync(MAP_FILE)) {
        console.log(`[准备工作] 从现有本地文件加载: ${MAP_FILE}`);
        return JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
    }

    console.log(`[准备工作] 正在从 CSV 生成映射字典: ${CSV_FILE}`);
    const fileStream = fs.createReadStream(CSV_FILE, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const map = {};
    let idIndex = -1;
    let emailIndex = -1;
    let isFirstLine = true;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const columns = parseCsvLine(line);

        if (isFirstLine) {
            idIndex = columns.indexOf('Customer ID');
            emailIndex = columns.indexOf('Customer Email');
            isFirstLine = false;
            continue;
        }

        const customerId = columns[idIndex]?.trim();
        const email = columns[emailIndex]?.trim().toLowerCase();
        if (customerId && email && email.includes('@')) {
            map[customerId] = email;
        }
    }

    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf-8');
    console.log(`[准备工作] 映射已缓存至 ${MAP_FILE}，共 ${Object.keys(map).length} 个用户`);
    return map;
}

// 3. 分页拉取 active membership 并通过字典匹配
async function fetchAndSyncActiveMemberships() {
    const customerMap = await loadOrGenerateCustomerMap();

    let nextUrl = `${BASE_URL}/membership_instances?page_size=200&status=active`;
    let pageCount = 1;
    let totalFetched = 0;
    let totalMatched = 0;
    let totalUnmatched = 0;

    console.log('\n🚀 开始拉取 Mariana Tek 活跃会员数据...');

    while (nextUrl) {
        console.log(`\n--- [Page ${pageCount}] 请求中: ${nextUrl} ---`);

        const res = await fetch(nextUrl, {
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Accept': 'application/vnd.api+json',
            },
        });

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Mariana Tek API 报错 [${res.status}]: ${errorText}`);
        }

        const json = await res.json();
        const memberships = json.data || [];
        totalFetched += memberships.length;

        // 匹配字典并格式化为 Custom Object 结构
        const readyRecords = [];

        for (const item of memberships) {
            const userId = item.relationships?.user?.data?.id;
            const email = customerMap[userId];

            if (!email) {
                totalUnmatched++;
                // 如果字典中没匹配到，可记录日志排查（可能是近期新注册但未在离线报表中的用户）
                // console.warn(`未匹配到邮箱: User ID ${userId}, Membership ID ${item.id}`);
                continue;
            }

            totalMatched++;
            readyRecords.push({
                id: item.id,
                name: item.attributes.membership_name,
                start_date: item.attributes.start_date || item.attributes.calculated_start_datetime,
                expiry_date: item.attributes.next_charge_date || item.attributes.payment_interval_end_date,
                membership_status: item.attributes.status,
                type: 'membership',
                is_expired: false,
                user_email: email, // 关联 Profile 的唯一标识
            });
        }

        console.log(`本页抓取: ${memberships.length} 条 | 匹配邮箱成功: ${readyRecords.length} 条`);

        // 4. 分批推送到 Klaviyo
        if (readyRecords.length > 0) {
            try {
                // await klaviyoApi.createDataSourceRecords(readyRecords);
                console.log(`✅ 已就绪/同步 ${readyRecords.length} 条记录至 Klaviyo`);
            } catch (syncErr) {
                console.error(`❌ Klaviyo 同步失败:`, syncErr.response?.data || syncErr.message);
            }
        }

        // 5. 翻页控制
        if (json.links?.next) {
            nextUrl = json.links.next.startsWith('http')
                ? json.links.next
                : `${BASE_URL}${json.links.next}`;
            pageCount++;

            // 接口频控缓冲（200ms）
            await new Promise((r) => setTimeout(r, 200));
        } else {
            nextUrl = null;
        }
    }

    console.log('\n================ 处理汇总 ================');
    console.log(`总翻页数: ${pageCount}`);
    console.log(`接口返回 Active 总数: ${totalFetched}`);
    console.log(`成功匹配邮箱总数: ${totalMatched}`);
    console.log(`未匹配到邮箱总数: ${totalUnmatched}`);
    console.log('==========================================');
}

fetchAndSyncActiveMemberships().catch((err) => {
    console.error('运行异常:', err);
});