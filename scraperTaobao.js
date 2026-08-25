// 淘宝商品详情爬虫 - mtop H5接口 + 登录Cookie + 代理IP竞态（与京东/1688方案一致）
// 核心技术：
//   1. 需要1个淘宝登录Cookie（环境变量 TAOBAO_COOKIE，浏览器登录后F12复制）——2026年淘宝已强制登录墙
//   2. mtop.taobao.detail.getdetail/6.0/ 获取详情（标题/价格/原价/SKU/主图/属性/店铺）
//   3. mtop.wdetail.getItemDescx/4.1/ 获取详情图
//   4. sign签名：md5(token + "&" + t + "&" + appKey + "&" + data)，token来自_m_h5_tk cookie
//   5. 代理IP + 并发竞态（与xfs/1688/京东相同的AbortController+signal方案）
const axios = require('axios');
const crypto = require('crypto');
const proxyManager = require('./proxyManager');

// ============ 配置 ============
const APP_KEY = '12574478';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const SINGLE_PROXY_TIMEOUT = 10000; // 单代理10秒超时
const TOTAL_REQUEST_TIMEOUT = 60000; // 总请求60秒超时
const PROXY_BATCH = 5; // 每轮并发5个代理
const MAX_ROUNDS = 8; // 最多8轮

// 淘宝登录Cookie（环境变量注入，必需）——浏览器登录 www.taobao.com 后复制全部Cookie
// 关键cookie: _m_h5_tk, _m_h5_tk_enc, cookie2, unb, cna, tracknick 等
// 也可用 get_cookie.js 扫码登录自动保存到 taobao_cookie.txt（免手动复制）
const fs = require('fs');
const path = require('path');

function loadCookieFromFile() {
  try {
    const p = path.join(__dirname, 'taobao_cookie.txt');
    if (fs.existsSync(p)) {
      const ck = fs.readFileSync(p, 'utf8').trim();
      if (ck) return ck;
    }
  } catch (e) { /* 文件读取失败时忽略 */ }
  return '';
}

const TAOBAO_COOKIE = process.env.TAOBAO_COOKIE || loadCookieFromFile();

// ============ 签名工具 ============

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

// 从 cookie 字符串提取 _m_h5_tk 的 token（下划线前部分）
function extractTokenFromCookie(cookieStr) {
  const m = (cookieStr || '').match(/_m_h5_tk=([^;]+)/);
  if (m) return m[1].split('_')[0];
  return '';
}

// 构造 mtop 请求 URL
function buildMtopUrl(api, v, dataObj, token) {
  const t = Date.now().toString();
  const data = JSON.stringify(dataObj);
  const sign = md5(token + '&' + t + '&' + APP_KEY + '&' + data);
  return `https://h5api.m.taobao.com/h5/${api}/${v}/?jsv=2.7.2&appKey=${APP_KEY}&t=${t}&sign=${sign}&api=${api}&v=${v}&dataType=json&data=${encodeURIComponent(data)}`;
}

// ============ HTTP请求（支持代理）============

async function fetchText(url, proxy, headers = {}, timeoutMs = SINGLE_PROXY_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const config = {
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://item.taobao.com/',
        ...headers,
      },
      timeout: timeoutMs,
      signal: controller.signal,
      maxRedirects: 3,
      validateStatus: () => true,
      responseType: 'text',
    };
    if (proxy) {
      config.httpsAgent = proxyManager.createAgent(proxy);
      config.httpAgent = proxyManager.createAgent(proxy);
    }
    const resp = await axios.get(url, config);
    return resp.data || '';
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ============ 响应判断 ============

// 判断响应是否为风控/挑战/登录页（返回true表示被拦截）
function isBlocked(body) {
  if (!body || body.length < 50) return true;
  // x5sec JS挑战
  if (body.includes('set_x5referer')) return true;
  // 登录跳转
  if (body.includes('login.taobao.com') || body.includes('login.m.taobao.com')) return true;
  // 滑块风控
  if (body.includes('RGV587') || body.includes('被挤爆')) return true;
  // 非JSON（HTML页面等）
  if (!body.trim().startsWith('{') && !body.trim().startsWith('[')) return true;
  return false;
}

// 解析 mtop JSON 响应
function parseMtop(body) {
  try {
    const j = JSON.parse(body);
    const ret = j.ret || [];
    if (ret.some((r) => r.startsWith('SUCCESS'))) {
      return { success: true, data: j.data || {}, ret };
    }
    return { success: false, data: null, ret };
  } catch (e) {
    return { success: false, data: null, ret: [] };
  }
}

// ============ Cookie管理 ============

// 合并cookie（以新cookie为准，覆盖同名字段）
function mergeCookies(cookieStr, newCookies) {
  const map = {};
  (cookieStr || '').split('; ').forEach((c) => {
    const idx = c.indexOf('=');
    if (idx > 0) map[c.substring(0, idx)] = c.substring(idx + 1);
  });
  (newCookies || []).forEach((c) => {
    const part = c.split(';')[0];
    const idx = part.indexOf('=');
    if (idx > 0) map[part.substring(0, idx)] = part.substring(idx + 1);
  });
  return Object.keys(map).map((k) => `${k}=${map[k]}`).join('; ');
}

// 提取响应中的 set-cookie
function getSetCookies(resp) {
  return (resp.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
}

// ============ 会话初始化（游客token + 登录cookie合并）============

// 用宽松配置接口获取游客token和基础cookie（无需登录），再合并用户登录cookie
async function initSession(proxy) {
  let cookieStr = TAOBAO_COOKIE || '';
  let token = extractTokenFromCookie(cookieStr);

  // 用户cookie中无token时，用游客token补全
  if (!token) {
    const b = buildMtopUrl('mtop.taobao.pc.growth.sem.homeconfigvo', '1.0', {}, '');
    const resp = await axios.get(b, {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.taobao.com/' },
      timeout: SINGLE_PROXY_TIMEOUT,
      validateStatus: () => true,
      ...(proxy ? { httpsAgent: proxyManager.createAgent(proxy), httpAgent: proxyManager.createAgent(proxy) } : {}),
    }).catch(() => null);
    if (resp && resp.headers) {
      cookieStr = mergeCookies(cookieStr, getSetCookies(resp));
      token = extractTokenFromCookie(cookieStr);
    }
  }

  // 确保cookie中包含token（游客token也可用于签名）
  if (token && !(cookieStr || '').includes('_m_h5_tk=')) {
    cookieStr = cookieStr + `; _m_h5_tk=${token}_${Date.now()}`;
  }

  return { cookieStr, token };
}

// ============ 详情数据解析 ============

// 从 mtop detail 返回的 data 中提取结构化详情
function parseDetailData(data, itemId) {
  const item = data.item || {};
  const skuBase = data.skuBase || {};
  const skusRaw = skuBase.skus || [];
  const props = skuBase.props || [];
  const images = Array.isArray(data.images) ? data.images : [];
  const propsMap = {}; // pid -> name
  props.forEach((p) => { propsMap[p.pid] = p.name || ''; });

  // 标题
  const title = item.title || item.subtitle || '';

  // 价格：现价 item.price，原价兼容多字段
  let price = '';
  let originalPrice = '';
  if (item.price) price = String(item.price);
  else if (item.priceText) price = String(item.priceText);
  // 原价：优先 priceWithRate（折前价），其次 promoData 或 priceText（当price取不到时）
  if (item.priceWithRate && item.priceWithRate !== price) originalPrice = String(item.priceWithRate);
  else if (item.originalPrice) originalPrice = String(item.originalPrice);
  else if (item.priceText && item.priceText !== price) originalPrice = String(item.priceText);
  // 促销信息兜底
  const promo = data.promoData || {};
  if (!originalPrice && promo.price) originalPrice = String(promo.price);

  // SKU列表
  const skus = skusRaw.map((sku) => {
    // propPath: "颜色:黑色;尺码:L" 或 "1627207:28330" 数字形式
    const propPairs = String(sku.propPath || '').split(';').filter(Boolean);
    const attrs = [];
    propPairs.forEach((pair) => {
      const [pid, value] = pair.split(':');
      // 数字pid映射名称；文字pid直接使用
      const propName = propsMap[pid] || '';
      const displayName = propName || pid;
      const displayValue = value || '';
      attrs.push({ name: displayName, value: displayValue, display: `${displayName}:${displayValue}` });
    });
    // 从value字段提取文字值（部分接口 value 是JSON数组）
    let valueText = '';
    try {
      const v = JSON.parse(sku.value || '[]');
      valueText = v.map((x) => x.name).filter(Boolean).join(' ');
    } catch (e) {
      valueText = '';
    }
    const specAttrs = attrs.map((a) => a.display).join(';');
    const name = valueText || attrs.map((a) => a.value).filter(Boolean).join(' ') || `SKU-${sku.skuId}`;
    return {
      skuId: String(sku.skuId || ''),
      name,
      specAttrs,
      price: sku.price ? String(sku.price) : price, // SKU现价
      originalPrice: '', // SKU原价由SKU接口补充
      stock: sku.quantity !== undefined ? Number(sku.quantity) : -1,
      imageUrl: sku.image || '',
    };
  });

  // 价格区间
  const priceRange = [];
  if (skus.length > 0) {
    const prices = skus.map((s) => parseFloat(s.price)).filter((n) => !isNaN(n));
    if (prices.length > 0) {
      priceRange = [String(Math.min(...prices)), String(Math.max(...prices))];
    }
  }

  // 属性列表
  const attributes = [];
  (item.propertyList || []).forEach((p) => {
    if (p.name && p.value) {
      attributes.push({ name: p.name, value: p.value });
    }
  });

  // 店铺
  const shopName = item.shopName || data.shopInfo?.title || '';

  // 销量
  let saleNum = '';
  if (item.soldCount) saleNum = String(item.soldCount);
  else if (item.sellCount) saleNum = String(item.sellCount);
  else if (data.soldOut) saleNum = String(data.soldOut);

  return {
    itemId: String(itemId),
    subject: title,
    price,
    originalPrice,
    priceRange,
    saleNum,
    shopName,
    shopUrl: data.shopInfo?.url || '',
    shopId: String(data.shopInfo?.shopId || item.shopId || ''),
    images,
    desc: [], // 稍后由详情图接口填充
    skus,
    skuCount: skus.length,
    attributes,
    videoUrl: item.videoUrl || '',
    detailUrl: `https://item.taobao.com/item.htm?id=${itemId}`,
    source: 'mtop.taobao.detail.getdetail H5接口',
    isMock: false,
    _token: '', // 内部使用
    _cookieStr: '', // 内部使用
  };
}

// ============ 详情图获取 ============

async function fetchDescImages(itemId, cookieStr, token, proxy) {
  const url = buildMtopUrl('mtop.wdetail.getItemDescx', '4.1', { item_num_id: itemId }, token);
  const body = await fetchText(url, proxy, { Cookie: cookieStr });
  if (isBlocked(body)) return [];
  const { success, data } = parseMtop(body);
  if (!success) return [];
  const images = Array.isArray(data.images) ? data.images : [];
  // 兜底：从 pages 中的 <img> 标签提取
  if (images.length === 0 && Array.isArray(data.pages)) {
    data.pages.forEach((page) => {
      const re = /<img[^>]*src="([^"]+)"/gi;
      let m;
      while ((m = re.exec(page)) !== null) images.push(m[1]);
    });
  }
  return images;
}

// ============ 详情获取（直连 + 代理竞态）============

async function fetchDetailOnce(itemId, cookieStr, token, proxy) {
  const url = buildMtopUrl('mtop.taobao.detail.getdetail', '6.0', { itemNumId: itemId }, token);
  const body = await fetchText(url, proxy, { Cookie: cookieStr });
  if (isBlocked(body)) return null;
  const { success, data } = parseMtop(body);
  if (!success) return null;
  const detail = parseDetailData(data, itemId);
  if (!detail.subject) return null;
  detail._token = token;
  detail._cookieStr = cookieStr;
  return detail;
}

async function getProductDetail(itemId) {
  console.log(`[TB] 获取商品详情: ${itemId}`);

  // ===== 会话初始化（纯代理模式下也走代理）=====
  let session = null;
  if (proxyManager.isEnabled()) {
    session = await initSession(proxyManager.getProxy() || null);
  } else {
    session = await initSession(null);
  }
  if (!session || !session.token) {
    console.warn('[TB] 会话初始化失败（无法获取token）');
    return generateMockDetail(itemId, '会话初始化失败');
  }
  const { cookieStr, token } = session;

  // ===== 代理竞态获取详情（与京东H5方案一致）=====
  let detail = null;
  let proxyUsed = null;

  if (proxyManager.isEnabled()) {
    console.log('[TB] 纯代理模式: 代理竞态获取详情...');
    const seenProxies = new Set();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const batch = [];
      for (let i = 0; i < PROXY_BATCH; i++) {
        const p = proxyManager.getProxy();
        if (p && !seenProxies.has(p)) { batch.push(p); seenProxies.add(p); }
      }
      if (batch.length === 0) break;
      console.log(`[TB] 详情代理第${round + 1}轮: ${batch.length}个代理...`);

      const results = await Promise.all(
        batch.map(async (proxy) => {
          const d = await fetchDetailOnce(itemId, cookieStr, token, proxy);
          return { proxy, detail: d };
        })
      );

      for (const r of results) {
        if (r.detail) {
          proxyManager.markSuccess(r.proxy);
          detail = r.detail;
          proxyUsed = r.proxy;
          console.log(`[TB] 详情成功(代理:${r.proxy}): ${itemId}, 标题: ${detail.subject?.substring(0, 30)}, 主图: ${detail.images.length}, SKU: ${detail.skuCount}`);
          break;
        } else {
          proxyManager.markFailed(r.proxy);
        }
      }
      if (detail) break;
    }
  } else {
    // 代理禁用时直连
    detail = await fetchDetailOnce(itemId, cookieStr, token, null);
    if (detail) {
      console.log(`[TB] 详情直连成功: ${itemId}, 标题: ${detail.subject?.substring(0, 30)}, 主图: ${detail.images.length}, SKU: ${detail.skuCount}`);
    }
  }

  if (!detail) {
    console.warn(`[TB] 详情获取失败: ${itemId}（若多次失败请检查TAOBAO_COOKIE是否有效）`);
    return generateMockDetail(itemId, '详情接口获取失败（可能需要有效的淘宝登录Cookie）');
  }

  // ===== 详情图获取 =====
  const descProxy = proxyManager.isEnabled() ? (proxyUsed || proxyManager.getProxy() || null) : null;
  const desc = await fetchDescImages(itemId, detail._cookieStr, detail._token, descProxy);
  if (desc.length > 0 && descProxy && proxyManager.isEnabled()) {
    proxyManager.markSuccess(descProxy);
  }
  detail.desc = desc;
  console.log(`[TB] 详情图: ${desc.length}张${descProxy ? ' (代理:' + descProxy + ')' : ''}`);

  // ===== 清理内部字段 =====
  delete detail._token;
  delete detail._cookieStr;

  console.log(`[TB] 完成: ${itemId}, 标题: ${detail.subject?.substring(0, 30)}, 现价: ${detail.price}, 原价: ${detail.originalPrice}, 主图: ${detail.images.length}, 详情图: ${detail.desc.length}, SKU: ${detail.skuCount}`);
  return detail;
}

// ============ Mock兜底 ============
function generateMockDetail(itemId, error) {
  return {
    itemId: String(itemId),
    subject: '淘宝商品（数据获取失败）',
    price: '',
    originalPrice: '',
    priceRange: [],
    saleNum: '',
    shopName: '',
    shopUrl: '',
    images: [],
    desc: [],
    skus: [],
    skuCount: 0,
    attributes: [],
    videoUrl: '',
    detailUrl: `https://item.taobao.com/item.htm?id=${itemId}`,
    source: 'mock',
    error: error || '详情接口获取失败',
    isMock: true,
  };
}

module.exports = {
  getProductDetail,
  parseDetailData,
  buildMtopUrl,
  isBlocked,
  getProxyStatus: () => proxyManager.getStatus(),
  setProxyEnabled: (enabled) => {
    proxyManager.setEnabled(enabled);
    return proxyManager.getStatus();
  },
  refreshProxies: async () => {
    const proxies = await proxyManager.refreshProxies(true);
    return { ...proxyManager.getStatus(), proxies_count: proxies.length };
  },
  cookieConfigured: () => !!TAOBAO_COOKIE,
};
