// ==UserScript==
// @name         豆包 · 侧栏对话按年月分组
// @name:en      Doubao Sidebar - Group Chats by Year & Month
// @namespace    https://greasyfork.org/users/1661485
// @version      1.3.0
// @description  在豆包网页版左侧栏增加「按年月分组」开关。点击后按 年-月 聚合全部历史对话（跨设备、跨项目）；点击条目用前端路由跳转、不刷新页面，并把选中的会话滚动到列表中间。
// @description:en  Adds a "Group by year & month" switch to the Doubao web sidebar. It regroups your full chat history (all devices, all projects) by YYYY-MM; clicking an entry navigates through the site's own client-side router (no page reload) and scrolls the selected chat to the middle of the list.
// @author       javalittleman1
// @license      MIT
// @match        https://www.doubao.com/*
// @match        https://doubao.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // 防止脚本被重复注入（多实例会互相覆盖界面状态）
  var RUN_FLAG = 'data-dbym-running';
  if (document.documentElement.getAttribute(RUN_FLAG) === '1') return;
  document.documentElement.setAttribute(RUN_FLAG, '1');

  var CFG = {
    pageSize: 50,              // 接口单页上限就是 50
    maxPages: 60,              // 最多 60 页（约 3000 条）
    nameChunk: 50,             // 每次补全标题的会话数量
    nameWorkers: 4,            // 并发补全标题的请求数
    cacheMs: 10 * 60 * 1000,   // 列表缓存 10 分钟
    groupField: 'create',      // 'create' = 按创建时间分月；改成 'update' = 按最后活动时间分月
    storageKey: 'dbym_enabled_v1'
  };

  var LIST_API = '/im/chain/recent_conv?version_code=20800&language=zh&device_platform=web' +
    '&doubao_device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version';
  var BATCH_API = '/im/conversation/batch_get?version_code=20800&language=zh&device_platform=web' +
    '&doubao_device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version';

  var cache = { at: 0, list: [] };
  var enabled = false;
  var busy = false;
  var syncTimer = 0;
  var renderToken = 0;
  var CENTER_KEY = 'dbym_center_id';   // 记住“需要居中显示”的会话 id（跨刷新有效）

  /* ---------------- 基础工具 ---------------- */

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fullTime(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function timeLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function monthOf(ts) {
    var d = new Date(ts * 1000);
    return {
      key: d.getFullYear() + '-' + pad(d.getMonth() + 1),
      label: d.getFullYear() + '年' + (d.getMonth() + 1) + '月'
    };
  }

  function uid() {
    return 'dbym-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function host() {
    var wrapper = document.querySelector('[data-testid="chat_list_wrapper"]');
    if (!wrapper || !wrapper.parentElement) return null;
    var scroller = wrapper.parentElement;          // 侧栏滚动容器
    var barHost = scroller.parentElement || scroller; // 滚动容器外层（开关常驻，不随内容滚动）
    return { wrapper: wrapper, container: scroller, barHost: barHost };
  }

  /* ---------------- 接口 ---------------- */

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json; encoding=utf-8',
        'Accept': 'application/json, text/plain, */*',
        'Agw-Js-Conv': 'str'
      },
      body: JSON.stringify(body)
    }).then(function (resp) { return resp.json(); });
  }

  function listPage(cursor) {
    var body = {
      cmd: 3200,
      uplink_body: {
        pull_recent_conv_chain_uplink_body: {
          conv_version: Number(cursor) || 0,
          limit: CFG.pageSize,
          filter: { conversation_type: [], project_filter: 0, device_filter: 0 },
          message_count_per_conv: 0,
          option: {
            not_need_message: true,
            need_complete_conversation: true,
            need_coco_bot: true,
            need_pc_pin_chain: true,
            pc_pin_query_type: 1,
            exclude_archive: true,
            only_archive: false
          },
          api_version: 1,
          direction: 2
        }
      },
      sequence_id: uid(),
      channel: 2,
      version: '1'
    };
    return post(LIST_API, body).then(function (data) {
      if (data.status_code !== 0) throw new Error(data.status_desc || ('status_code ' + data.status_code));
      var down = data.downlink_body && data.downlink_body.pull_recent_conv_chain_downlink_body;
      if (!down) throw new Error('会话列表接口返回为空');
      return down;
    });
  }

  function nameChunk(ids) {
    var body = {
      cmd: 1111,
      uplink_body: {
        batch_get_conv_info_uplink_body: {
          conversation_id: ids,
          option: { recent_message_count_per_conv: 0 },
          ext: {}
        }
      },
      sequence_id: uid(),
      channel: 2,
      version: '1'
    };
    return post(BATCH_API, body).then(function (data) {
      if (data.status_code !== 0) throw new Error(data.status_desc || ('status_code ' + data.status_code));
      var down = data.downlink_body && data.downlink_body.batch_get_conv_info_downlink_body;
      return (down && down.conversation_info_list) || [];
    });
  }

  /* ---------------- 数据加载 ---------------- */

  function loadList(onProgress) {
    var map = {};
    var state = { cursor: 0, pages: 0, more: true };

    function step() {
      if (!state.more || state.pages >= CFG.maxPages) return Promise.resolve();
      return listPage(state.cursor).then(function (page) {
        var cells = page.cells || [];
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i] && cells[i].conversation;
          if (!c || !c.conversation_id) continue;
          var id = String(c.conversation_id);
          var create = Number(c.create_time) || 0;
          var update = Number(c.update_time) || 0;
          map[id] = {
            id: id,
            name: (c.name || '').trim(),
            create: create,
            update: update,
            ts: CFG.groupField === 'update' ? (update || create) : (create || update)
          };
        }
        state.pages += 1;
        if (onProgress) onProgress(state.pages, Object.keys(map).length);
        var next = Number(page.next_conv_version);
        state.more = !!page.has_more && !!next && next !== state.cursor;
        state.cursor = next;
        return step();
      });
    }

    return step().then(function () {
      var list = Object.keys(map).map(function (k) { return map[k]; });
      list.sort(function (a, b) { return b.ts - a.ts; });
      return list;
    });
  }

  function loadAll(force, onProgress) {
    if (!force && cache.list.length && Date.now() - cache.at < CFG.cacheMs) {
      return Promise.resolve(cache.list);
    }
    return loadList(onProgress).then(function (list) {
      cache = { at: Date.now(), list: list };
      return list;
    });
  }

  /* ---------------- 样式 ---------------- */

  var STYLE_ID = 'dbym-style';
  var CSS = [
    '#dbym-bar,#dbym-panel{',
    '--dbym-text:rgba(0,0,0,.88);--dbym-sub:rgba(0,0,0,.38);--dbym-hover:rgba(0,0,0,.05);',
    '--dbym-active:rgba(0,0,0,.07);--dbym-line:rgba(0,0,0,.05);font-family:inherit;}',
    'html[data-theme="dark"] #dbym-bar,html[data-theme="dark"] #dbym-panel{',
    '--dbym-text:rgba(255,255,255,.88);--dbym-sub:rgba(255,255,255,.42);',
    '--dbym-hover:rgba(255,255,255,.08);--dbym-active:rgba(255,255,255,.12);',
    '--dbym-line:rgba(255,255,255,.06);}',
    '#dbym-bar{display:flex;align-items:center;gap:2px;padding:2px 2px 4px 2px;}',
    '#dbym-bar button{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;',
    'font-size:12px;line-height:18px;height:26px;padding:0 8px;border-radius:8px;color:var(--dbym-sub);',
    'display:inline-flex;align-items:center;gap:4px;white-space:nowrap;transition:background-color .15s,color .15s;}',
    '#dbym-bar button:hover{background:var(--dbym-hover);color:var(--dbym-text);}',
    '#dbym-bar #dbym-refresh{margin-left:auto;padding:0 6px;display:none;}',
    '#dbym-panel{display:flex;flex-direction:column;padding:0 0 16px 0;}',
    '#dbym-panel .dbym-summary{font-size:11px;line-height:16px;color:var(--dbym-sub);padding:6px 10px 2px 10px;}',
    '#dbym-panel .dbym-group{margin-top:2px;}',
    '#dbym-panel .dbym-group-header{display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;',
    'border-radius:9px;cursor:pointer;color:var(--dbym-sub);font-size:12px;font-weight:500;user-select:none;}',
    '#dbym-panel .dbym-group-header:hover{background:var(--dbym-hover);}',
    '#dbym-panel .dbym-group-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#dbym-panel .dbym-group-count{flex:0 0 auto;font-size:11px;opacity:.75;}',
    '#dbym-panel .dbym-arrow{flex:0 0 auto;font-size:10px;transition:transform .15s;opacity:.8;}',
    '#dbym-panel .dbym-group.dbym-collapsed .dbym-arrow{transform:rotate(-90deg);}',
    '#dbym-panel .dbym-group.dbym-collapsed .dbym-group-body{display:none;}',
    '#dbym-panel .dbym-item{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border-radius:10px;',
    'text-decoration:none;color:var(--dbym-text);font-size:14px;line-height:22px;overflow:hidden;}',
    '#dbym-panel .dbym-item:hover{background:var(--dbym-hover);}',
    '#dbym-panel .dbym-item.dbym-active{background:var(--dbym-active);}',
    '#dbym-panel .dbym-item-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#dbym-panel .dbym-item-title.dbym-pending{color:var(--dbym-sub);}',
    '#dbym-panel .dbym-item-time{flex:0 0 auto;font-size:11px;color:var(--dbym-sub);font-variant-numeric:tabular-nums;}',
    '#dbym-panel .dbym-empty{padding:14px 10px;font-size:12px;line-height:18px;color:var(--dbym-sub);}'
  ].join('');

  function ensureStyle() {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      (document.head || document.documentElement).appendChild(el);
    }
  }

  /* ---------------- 渲染 ---------------- */

  function panelNode() {
    var panel = document.getElementById('dbym-panel');
    if (panel) return panel;
    var ctx = host();
    if (!ctx) return null;
    panel = document.createElement('div');
    panel.id = 'dbym-panel';
    ctx.container.insertBefore(panel, ctx.wrapper.nextSibling);
    return panel;
  }

  function summaryText(total, extra) {
    var base = '共 ' + total + ' 条对话 · 按' + (CFG.groupField === 'update' ? '最后活动' : '创建') + '时间分月';
    return extra ? base + ' · ' + extra : base;
  }

  function buildPanel(list) {
    var panel = document.createElement('div');
    panel.id = 'dbym-panel';

    var summary = document.createElement('div');
    summary.className = 'dbym-summary';
    summary.textContent = summaryText(list.length, '');
    panel.appendChild(summary);

    var currentId = (location.pathname.match(/\/chat\/(\d+)/) || [])[1] || '';
    var buckets = [];
    var byKey = {};

    for (var i = 0; i < list.length; i++) {
      var m = monthOf(list[i].ts);
      if (!byKey[m.key]) {
        byKey[m.key] = { label: m.label, items: [] };
        buckets.push(byKey[m.key]);
      }
      byKey[m.key].items.push(list[i]);
    }

    buckets.forEach(function (bucket) {
      var group = document.createElement('div');
      group.className = 'dbym-group';

      var header = document.createElement('div');
      header.className = 'dbym-group-header';
      header.setAttribute('role', 'button');
      header.setAttribute('title', bucket.label + '：点击折叠 / 展开');

      var name = document.createElement('span');
      name.className = 'dbym-group-name';
      name.textContent = bucket.label;

      var count = document.createElement('span');
      count.className = 'dbym-group-count';
      count.textContent = bucket.items.length + ' 条';

      var arrow = document.createElement('span');
      arrow.className = 'dbym-arrow';
      arrow.textContent = '▾';

      header.appendChild(name);
      header.appendChild(count);
      header.appendChild(arrow);
      header.addEventListener('click', function () { group.classList.toggle('dbym-collapsed'); });

      var body = document.createElement('div');
      body.className = 'dbym-group-body';

      bucket.items.forEach(function (item) {
        var a = document.createElement('a');
        a.className = 'dbym-item' + (currentId && currentId === item.id ? ' dbym-active' : '');
        a.href = '/chat/' + item.id;
        a.title = (item.name || '未命名对话') + '\n' + fullTime(item.ts);
        a.addEventListener('click', function (ev) {
          // 保留 Ctrl/⌘ 点击在新标签打开的原生行为
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
          ev.preventDefault();
          navigateTo(item.id);
        });

        var title = document.createElement('span');
        title.className = 'dbym-item-title' + (item.name ? '' : ' dbym-pending');
        title.setAttribute('data-id', item.id);
        title.textContent = item.name || '读取中…';

        var time = document.createElement('span');
        time.className = 'dbym-item-time';
        time.textContent = timeLabel(item.ts);

        a.appendChild(title);
        a.appendChild(time);
        body.appendChild(a);
      });

      group.appendChild(header);
      group.appendChild(body);
      panel.appendChild(group);
    });

    return panel;
  }

  function setPanelHtml(html) {
    var panel = panelNode();
    if (panel) panel.innerHTML = html;
  }

  function fillNames(panel, list, token) {
    var pending = list.filter(function (x) { return !x.name; }).map(function (x) { return x.id; });
    if (!pending.length) return;

    var chunks = [];
    for (var i = 0; i < pending.length; i += CFG.nameChunk) {
      chunks.push(pending.slice(i, i + CFG.nameChunk));
    }
    var totalChunks = chunks.length;
    var done = 0;
    var summary = panel.querySelector('.dbym-summary');

    function worker() {
      if (!chunks.length) return Promise.resolve();
      var ids = chunks.shift();
      return nameChunk(ids).then(function (rows) {
        rows.forEach(function (row) {
          var id = String(row.conversation_id);
          var titleEl = panel.querySelector('.dbym-item-title[data-id="' + id + '"]');
          var name = (row.name || '').trim();
          if (!name) return;
          if (titleEl) {
            titleEl.textContent = name;
            titleEl.classList.remove('dbym-pending');
            var link = titleEl.parentElement;
            if (link) link.setAttribute('title', name + (link.getAttribute('title') || '').split('\n').slice(1).join('\n'));
          }
          for (var k = 0; k < list.length; k++) {
            if (list[k].id === id) { list[k].name = name; break; }
          }
        });
      }).catch(function () {
        /* 单个分片失败就保留占位，不影响整体 */
      }).then(function () {
        done += 1;
        if (token !== renderToken) return;
        if (summary) summary.textContent = summaryText(list.length, '标题加载中 ' + done + '/' + totalChunks);
        return worker();
      });
    }

    var tasks = [];
    for (var w = 0; w < Math.min(CFG.nameWorkers, totalChunks); w++) tasks.push(worker());
    Promise.all(tasks).then(function () {
      if (token !== renderToken) return;
      var s = panel.querySelector('.dbym-summary');
      if (s) s.textContent = summaryText(list.length, '');
    });
  }

  function renderPanel(force) {
    if (!host() || busy) return;
    var token = ++renderToken;
    busy = true;
    setPanelHtml('<div class="dbym-empty">正在读取对话列表…</div>');

    loadAll(force, function (pages, count) {
      if (token !== renderToken) return;
      setPanelHtml('<div class="dbym-empty">正在读取对话列表… 已读取 ' + count + ' 条</div>');
    }).then(function (list) {
      if (token !== renderToken) {
        busy = false;
        return;
      }
      var fresh = buildPanel(list);
      var ctxNow = host();
      var prevScroll = ctxNow && ctxNow.container ? ctxNow.container.scrollTop : 0;
      var cur = document.getElementById('dbym-panel');
      if (cur && cur.parentNode) cur.parentNode.replaceChild(fresh, cur);
      else if (ctxNow) ctxNow.container.insertBefore(fresh, ctxNow.wrapper.nextSibling);

      if (ctxNow && ctxNow.container) ctxNow.container.scrollTop = prevScroll;
      busy = false;

      // 跳转后（或整页刷新后）把选中的会话滚到列表中间
      var want = '';
      try { want = sessionStorage.getItem(CENTER_KEY) || ''; } catch (e) {}
      if (want && want === currentConvId()) {
        setTimeout(function () {
          if (centerItem(fresh, want)) {
            try { sessionStorage.removeItem(CENTER_KEY); } catch (e) {}
          }
        }, 60);
      }

      fillNames(fresh, list, token);
    }).catch(function (err) {
      busy = false;
      setPanelHtml('<div class="dbym-empty">读取失败：' +
        escapeHtml(err && err.message ? err.message : err) +
        '<br>请确认已登录豆包，然后点右上角「刷新」重试。</div>');
    });
  }

  /* ---------------- 选中态与滚动定位 ---------------- */

  function currentConvId() {
    return (location.pathname.match(/\/chat\/(\d+)/) || [])[1] || '';
  }

  function findItem(panel, id) {
    var all = panel.querySelectorAll('.dbym-item');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('href') === '/chat/' + id) return all[i];
    }
    return null;
  }

  // 把某个会话滚到可见区域的正中间
  function centerItem(panel, id) {
    var ctx = host();
    if (!ctx || !ctx.container) return false;
    var target = findItem(panel, id);
    if (!target) return false;

    var group = target.closest('.dbym-group');
    if (group && group.classList.contains('dbym-collapsed')) group.classList.remove('dbym-collapsed');

    var cr = ctx.container.getBoundingClientRect();
    var ar = target.getBoundingClientRect();
    var delta = (ar.top - cr.top) - Math.max(0, (cr.height - ar.height) / 2);
    if (Math.abs(delta) < 4) return true;
    ctx.container.scrollTop = Math.max(0, ctx.container.scrollTop + delta);
    return true;
  }

  function refreshActive(center) {
    var panel = document.getElementById('dbym-panel');
    if (!panel) return;
    var currentId = currentConvId();
    var marked = panel.querySelectorAll('.dbym-item.dbym-active');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('dbym-active');
    if (!currentId) return;
    var target = findItem(panel, currentId);
    if (!target) return;
    target.classList.add('dbym-active');
    if (center) centerItem(panel, currentId);
  }

  // 前端路由跳转，避免整页刷新
  function navigateTo(id) {
    var href = '/chat/' + id;
    if (location.pathname === href) {
      refreshActive(true);
      return;
    }

    var oldTitle = document.title;
    try {
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (e) {
      location.href = href;
      return;
    }

    try { sessionStorage.setItem(CENTER_KEY, id); } catch (e) {}

    setTimeout(function () { refreshActive(true); }, 150);
    setTimeout(function () { refreshActive(true); }, 700);

    // 若 3 秒后标题未变化，说明前端路由没有接管，退回整页跳转
    setTimeout(function () {
      if (document.title === oldTitle && location.pathname === href) location.href = href;
    }, 3000);
  }

  /* ---------------- 状态 ---------------- */

  function applyState() {
    var ctx = host();
    var btn = document.getElementById('dbym-btn');
    var refresh = document.getElementById('dbym-refresh');
    if (btn) btn.textContent = enabled ? '返回最近列表' : '按年月分组';
    if (refresh) refresh.style.display = enabled ? 'inline-flex' : 'none';
    if (!ctx) return;

    if (!enabled) {
      ctx.wrapper.style.display = '';
      var old = document.getElementById('dbym-panel');
      if (old) old.style.display = 'none';
      return;
    }

    ctx.wrapper.style.display = 'none';
    var panel = panelNode();
    if (panel) {
      panel.style.display = '';
      if (!panel.querySelector('.dbym-summary') && !panel.querySelector('.dbym-empty')) {
        renderPanel(false);
      }
    }
  }

  function mount() {
    var ctx = host();
    if (!ctx) return false;

    if (!document.getElementById('dbym-bar')) {
      var bar = document.createElement('div');
      bar.id = 'dbym-bar';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'dbym-btn';
      btn.textContent = '按年月分组';
      btn.title = '按 年-月 查看全部对话';
      btn.addEventListener('click', function () {
        var now = Date.now();
        if (now - (btn.__dbymLastClick || 0) < 300) return;  // 去抖，避免一次点击被重复处理
        btn.__dbymLastClick = now;
        enabled = !enabled;
        try { localStorage.setItem(CFG.storageKey, enabled ? '1' : '0'); } catch (e) {}
        applyState();
        if (enabled) {
          var ctx = host();
          if (ctx && ctx.container) ctx.container.scrollTop = 0;
          var panel = document.getElementById('dbym-panel');
          if (!panel || !panel.querySelector('.dbym-summary')) renderPanel(false);
        }
      });

      var refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.id = 'dbym-refresh';
      refresh.textContent = '刷新';
      refresh.title = '重新读取对话列表';
      refresh.style.display = 'none';
      refresh.addEventListener('click', function () {
        cache = { at: 0, list: [] };
        renderPanel(true);
      });

      bar.appendChild(btn);
      bar.appendChild(refresh);
      ctx.barHost.insertBefore(bar, ctx.container);
    }

    ensureStyle();
    applyState();
    return true;
  }

  function sync() {
    if (!mount()) return;
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = 0;
      sync();
    }, 180);
  }

  function isOwnNode(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el) {
      if (el.id === 'dbym-bar' || el.id === 'dbym-panel') return true;
      el = el.parentElement;
    }
    return false;
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    try { enabled = localStorage.getItem(CFG.storageKey) === '1'; } catch (e) { enabled = false; }

    mount();
    ensureStyle();

    var obs = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (!isOwnNode(records[i].target)) { scheduleSync(); return; }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', scheduleSync);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleSync();
    });

    // 兜底：React 重渲染可能移除节点；同时同步当前会话高亮
    setInterval(function () {
      if (!document.getElementById('dbym-bar')) { scheduleSync(); return; }
      if (!enabled) return;
      var panel = document.getElementById('dbym-panel');
      if (!panel) { scheduleSync(); return; }
      refreshActive(false);
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  var tries = 0;
  var retry = setInterval(function () {
    tries += 1;
    sync();
    if (tries > 40) clearInterval(retry);
  }, 500);
})();
