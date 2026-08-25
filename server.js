// 淘宝商品详情API - mtop H5接口 + 登录Cookie + 代理IP自动刷新池（与京东/1688方案一致）
// 部署到Render的独立Node.js服务
// 注意：淘宝2026年已强制登录墙，需配置环境变量 TAOBAO_COOKIE（浏览器登录淘宝后复制）
const express = require('express');
const cors = require('cors');
const scraperTaobao = require('./scraperTaobao');
const proxyManager = require('./proxyManager');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// ============ 全局错误防护（防止未捕获异常导致服务崩溃）============
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err && err.message ? err.message : err);
});

// ============ 健康检查端点（Render 必需，必须最先注册）============
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============ 首页 - API说明 ============
app.get('/', (req, res) => {
  res.json({
    service: 'Taobao Product API',
    version: '1.0.0',
    description: '淘宝商品详情API - mtop H5接口 + 登录Cookie + 纯代理IP自动刷新池',
    mode: '纯代理模式（强制代理IP，与京东/1688方案一致）',
    features: {
      cookie_required: true,
      cookie_config: '配置环境变量 TAOBAO_COOKIE（浏览器登录淘宝后F12复制的Cookie，仅需1个，扫码获取）',
      cookie_configured: scraperTaobao.cookieConfigured(),
      proxy_mode: '纯代理模式（详情/详情图全部走代理池）',
      protocols_supported: ['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5'],
      detail_source: 'mtop.taobao.detail.getdetail/6.0/ H5接口（标题/价格/原价/SKU/主图/属性/店铺）',
      desc_source: 'mtop.wdetail.getItemDescx/4.1/ 详情图接口',
      sign_algorithm: 'sign = md5(token & t & appKey & data)，token来自_m_h5_tk cookie',
      detail_strategy: '代理竞态 → 详情图 → Mock兜底',
      proxy_pool: '13源自动刷新代理池（每30分钟，与京东/1688/亚马逊方案一致）',
    },
    endpoints: {
      detail: 'GET /api/detail/:itemId',
      proxy_status: 'GET /api/proxy/status',
      proxy_enable: 'POST /api/proxy/enable { "enabled": true }',
      proxy_refresh: 'POST /api/proxy/refresh',
      proxy_auto_refresh: 'POST /api/proxy/auto-refresh { "enabled": true, "intervalMinutes": 30 }',
      test: 'GET /api/test (执行自动测试)',
    },
    constraints: {
      proxy_timeout: '10秒/代理',
      total_timeout: '60秒总超时',
      max_proxies: '最多40个代理尝试（5并发×8轮）',
      max_uses_per_proxy: '单代理最多5次',
      auto_refresh_interval: '30分钟（与京东/1688方案一致）',
    },
    proxy_status: proxyManager.getStatus(),
  });
});

// ============ 代理状态管理 ============
app.get('/api/proxy/status', (req, res) => {
  try {
    res.json({
      success: true,
      message: '获取代理状态成功',
      data: scraperTaobao.getProxyStatus(),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '获取代理状态失败' });
  }
});

app.post('/api/proxy/enable', (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: '请提供enabled参数 (true/false)' });
    }
    const status = scraperTaobao.setProxyEnabled(enabled);
    res.json({
      success: true,
      message: enabled ? '代理已启用' : '代理已禁用',
      data: status,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '设置代理状态失败' });
  }
});

app.post('/api/proxy/refresh', async (req, res) => {
  try {
    const status = await scraperTaobao.refreshProxies();
    res.json({ success: true, message: '代理池刷新成功', data: status });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '刷新代理池失败',
    });
  }
});

// ============ 自动刷新控制（与京东/1688方案一致的轮换IP池）============
app.post('/api/proxy/auto-refresh', (req, res) => {
  try {
    const { enabled, intervalMinutes } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: '请提供enabled参数 (true/false)' });
    }
    if (enabled) {
      const interval = (typeof intervalMinutes === 'number' && intervalMinutes >= 5 && intervalMinutes <= 1440)
        ? intervalMinutes
        : 30;
      proxyManager.startAutoRefresh(interval);
      res.json({
        success: true,
        message: `自动刷新已启动（每${interval}分钟刷新一次）`,
        data: proxyManager.getStatus(),
      });
    } else {
      proxyManager.stopAutoRefresh();
      res.json({
        success: true,
        message: '自动刷新已停止',
        data: proxyManager.getStatus(),
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '设置自动刷新失败',
    });
  }
});

app.get('/api/proxy/auto-refresh', (req, res) => {
  try {
    res.json({
      success: true,
      message: '获取自动刷新状态成功',
      data: proxyManager.getAutoRefreshStatus(),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '获取自动刷新状态失败' });
  }
});

// ============ 商品详情（参数结构与1688/JD一致：路径参数传商品ID）============
app.get('/api/detail/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!itemId) {
      return res.status(400).json({ success: false, message: '请提供商品ID (itemId)' });
    }
    if (!scraperTaobao.cookieConfigured()) {
      return res.status(400).json({
        success: false,
        message: '未配置TAOBAO_COOKIE环境变量。淘宝2026年起强制登录墙，需先配置登录Cookie（浏览器登录淘宝后F12复制）。',
      });
    }

    const detail = await scraperTaobao.getProductDetail(itemId);
    if (!detail) {
      return res.status(404).json({ success: false, message: '未找到商品详情' });
    }

    res.json({
      success: true,
      message: '获取商品详情成功',
      data: detail,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '获取商品详情失败',
    });
  }
});

// ============ 自动化测试端点 ============
app.get('/api/test', async (req, res) => {
  try {
    const ITEM_IDS = ['803538819372', '1056901855055', '826904851814', '757437513276'];
    const itemId = ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)];

    console.log(`[Test] 自动测试: ${itemId}`);
    const detail = await scraperTaobao.getProductDetail(itemId);

    res.json({
      success: true,
      message: '自动测试完成',
      data: {
        itemId,
        detail: {
          itemId: detail.itemId,
          subject: detail.subject,
          price: detail.price,
          originalPrice: detail.originalPrice,
          shopName: detail.shopName,
          imageCount: detail.images?.length || 0,
          descCount: detail.desc?.length || 0,
          skuCount: detail.skus?.length || 0,
          attributeCount: detail.attributes?.length || 0,
          source: detail.source || 'unknown',
          isMock: detail.isMock || false,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '自动测试失败',
    });
  }
});

// ============ 兜底路由（返回JSON而非默认404页面）============
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: '接口不存在',
    available_endpoints: {
      health: 'GET /health',
      home: 'GET /',
      detail: 'GET /api/detail/:itemId',
      proxy_status: 'GET /api/proxy/status',
      proxy_enable: 'POST /api/proxy/enable',
      proxy_refresh: 'POST /api/proxy/refresh',
      proxy_auto_refresh: 'POST /api/proxy/auto-refresh (启动/停止自动刷新) | GET /api/proxy/auto-refresh (查看状态)',
      test: 'GET /api/test',
    },
  });
});

// ============ 启动服务 ============
const server = app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Taobao Product API 服务已启动`);
  console.log(`  端口: ${PORT}`);
  console.log(`  模式: mtop H5接口 + 登录Cookie + 代理IP`);
  console.log(`  TAOBAO_COOKIE 已配置: ${scraperTaobao.cookieConfigured()}`);
  console.log(`  代理池: 13源自动刷新（每30分钟，与京东/1688方案一致）`);
  console.log(`  健康检查: http://localhost:${PORT}/health`);
  console.log(`  API文档: http://localhost:${PORT}/`);
  console.log(`${'='.repeat(60)}\n`);
});

// 后台初始化代理池（不阻塞服务启动）
setTimeout(async () => {
  try {
    console.log('[启动] 后台初始化代理池...');
    const proxies = await proxyManager.refreshProxies(true);
    console.log(`[启动] 代理池初始化完成: ${proxies.length} 个代理`);

    proxyManager.startAutoRefresh(30);
    console.log('[启动] 代理池自动刷新定时器已启动（每30分钟）');
  } catch (e) {
    console.error('[启动] 代理池初始化失败:', e.message);
    proxyManager.startAutoRefresh(30);
  }
}, 1000);

// 优雅关闭：停止定时器
process.on('SIGTERM', () => {
  console.log('[关闭] 收到SIGTERM信号，停止自动刷新定时器...');
  proxyManager.stopAutoRefresh();
  server.close(() => {
    console.log('[关闭] 服务已停止');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[关闭] 收到SIGINT信号，停止自动刷新定时器...');
  proxyManager.stopAutoRefresh();
  server.close(() => {
    console.log('[关闭] 服务已停止');
    process.exit(0);
  });
});

module.exports = { app, server };
