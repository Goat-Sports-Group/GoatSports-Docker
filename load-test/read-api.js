// Load test các API đọc công khai (NFR-01): API p95 <= 500 ms, tìm sân có cache p95 <= 200 ms.
// Chỉ GET, không đăng nhập, không ghi dữ liệu. Lỗi > 1% thì k6 tự dừng để không làm ảnh hưởng production.
//
// Gateway giới hạn 20 req/s mỗi IP cho mỗi service (RateLimiterConfig, Redis token bucket, burst 100). Mặc định
// 20 req/s chia ~14 vào venue-service và ~6 vào club-service: nằm dưới giới hạn nên số đo là độ trễ thật, không
// lẫn 429. Muốn đo thông lượng cao hơn thì phải nới rate limit trước, nếu không phần vượt sẽ là 429.
//
//   k6 run read-api.js                                  # đo chính thức: 20 req/s trong 2 phút
//   k6 run -e RATE=10 -e DURATION=20s read-api.js       # thử nhanh
//   k6 run -e BASE_URL=http://localhost:7070 read-api.js
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://api.goatsports.click';
const RATE = Number(__ENV.RATE || 20);
const DURATION = __ENV.DURATION || '2m';

// Vài bộ lọc người dùng hay chọn. Lặp lại nên trúng cache Caffeine (TTL 60 s) sau lượt đầu.
const SEARCHES = [
  'page=0&size=10',
  'sportType=FOOTBALL&page=0&size=10',
  'sportType=BADMINTON&page=0&size=10',
  'sportType=PICKLEBALL&page=0&size=10',
  'sportType=TENNIS&page=0&size=10',
  'city=H%E1%BB%93%20Ch%C3%AD%20Minh&page=0&size=10',
];

export const options = {
  scenarios: {
    read_api: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, RATE),
      maxVUs: Math.max(50, RATE * 5),
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<500'],
    'http_req_duration{endpoint:search_cached}': ['p(95)<200'],
    'http_req_duration{endpoint:venue_detail}': ['p(95)<500'],
    'http_req_duration{endpoint:tournament_search}': ['p(95)<500'],
    'http_req_duration{endpoint:club_search}': ['p(95)<500'],
    'http_req_duration{endpoint:club_featured}': ['p(95)<500'],
    'http_req_failed': [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '10s' }],
    'checks': ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const res = http.get(`${BASE_URL}/venue-service/api/v1/venues?page=0&size=50`);
  const ids = (res.json('data.items') || []).map((venue) => venue.venueId);
  if (ids.length === 0) throw new Error(`Không lấy được danh sách sân: HTTP ${res.status}`);
  return { venueIds: ids };
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export default function (data) {
  const roll = Math.random();
  let endpoint;
  let path;
  if (roll < 0.5) {
    endpoint = 'search_cached';
    path = `/venue-service/api/v1/venues?${pick(SEARCHES)}`;
  } else if (roll < 0.7) {
    endpoint = 'venue_detail';
    path = `/venue-service/api/v1/venues/${pick(data.venueIds)}`;
  } else if (roll < 0.8) {
    endpoint = 'tournament_search';
    path = '/club-service/api/v1/tournaments/search?page=0&size=10';
  } else if (roll < 0.9) {
    endpoint = 'club_search';
    path = '/club-service/api/v1/clubs/search?page=0&size=10';
  } else {
    endpoint = 'club_featured';
    path = '/club-service/api/v1/clubs/featured';
  }
  const res = http.get(`${BASE_URL}${path}`, { tags: { endpoint, name: endpoint } });
  check(res, { 'HTTP 200': (r) => r.status === 200, 'không bị rate limit (429)': (r) => r.status !== 429 });
}

export function handleSummary(data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const metric = (name) => data.metrics[name] && data.metrics[name].values;
  const ms = (value) => (value === undefined ? '-' : `${value.toFixed(0)} ms`);
  const rows = ['search_cached', 'venue_detail', 'tournament_search', 'club_search', 'club_featured'].map((name) => {
    const v = metric(`http_req_duration{endpoint:${name}}`) || {};
    return `| ${name} | ${ms(v.med)} | ${ms(v['p(95)'])} | ${ms(v['p(99)'])} |`;
  });
  const all = metric('http_req_duration');
  const reqs = metric('http_reqs');
  const failed = metric('http_req_failed');
  const thresholds = Object.entries(data.metrics)
    .filter(([, m]) => m.thresholds)
    .flatMap(([name, m]) => Object.entries(m.thresholds).map(([rule, r]) => `| ${name} | ${rule} | ${r.ok ? 'ĐẠT' : 'KHÔNG ĐẠT'} |`));
  const rateLimited = (data.root_group.checks.find((c) => c.name.includes('429')) || { fails: 0 }).fails;
  const report = [
    `# Load test — ${new Date().toISOString()}`,
    '',
    `Đích: ${BASE_URL}, ${RATE} req/s đều trong ${DURATION}. Đo từ phía client (gồm cả mạng Internet và Cloudflare),`
      + ' chỉ API GET công khai.',
    '',
    `- Tổng request: ${reqs.count}, trung bình ${reqs.rate.toFixed(1)} req/s`,
    `- Request bị rớt do không theo kịp lịch (dropped_iterations): ${(metric('dropped_iterations') || { count: 0 }).count}`,
    `- Bị rate limit (HTTP 429): ${rateLimited}`,
    `- Tỉ lệ lỗi: ${(failed.rate * 100).toFixed(2)}%`,
    `- Toàn bộ API: median ${ms(all.med)}, p95 ${ms(all['p(95)'])}, p99 ${ms(all['p(99)'])}`,
    '',
    '| Endpoint | median | p95 | p99 |',
    '|---|---|---|---|',
    ...rows,
    '',
    '| Metric | Ngưỡng | Kết quả |',
    '|---|---|---|',
    ...thresholds,
    '',
  ].join('\n');
  const prefix = `results/${stamp}-${RATE}rps-${DURATION}`;
  return {
    stdout: report,
    [`${prefix}.md`]: report,
    [`${prefix}.json`]: JSON.stringify(data, null, 2),
  };
}
