/* app.js — 우리 모임 설문 화면 (깃허브 페이지용, 순수 JavaScript)
 *
 *  - 데이터는 config.js 의 GAS_URL(Apps Script 웹앱)과 JSON 으로 주고받는다.
 *    로컬 미리보기(window.__MOCK__)에서는 .gs 함수를 브라우저 안에서 직접 부른다.
 *  - 화면 세 개: #survey(응답) · #results(결과) · #admin(운영자)
 *  - 문항 정의(apiMeta)는 localStorage 에 담아 두고, 두 번째 접속부터는 바로 그린 뒤 뒤에서 새로 받는다.
 */
(function () {
  'use strict';

  // ───────────────────────── 작은 도구 ─────────────────────────
  function $(s, root) { return (root || document).querySelector(s); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'style') n.style.cssText = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var toastTimer;
  function toast(msg, ms) { var t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2200); }
  function overlay(show, text) { var o = $('#overlay'); if (show) { $('#overlayText').textContent = text || '저장 중…'; o.hidden = false; } else o.hidden = true; }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('sv.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('sv.' + k, JSON.stringify(v)); } catch (e) { } },
    del: function (k) { try { localStorage.removeItem('sv.' + k); } catch (e) { } }
  };
  var sess = {
    get: function (k, d) { try { var v = sessionStorage.getItem('sv.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { sessionStorage.setItem('sv.' + k, v); } catch (e) { } },
    del: function (k) { try { sessionStorage.removeItem('sv.' + k); } catch (e) { } }
  };
  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || '복사했습니다'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('아래 내용을 복사하세요', text); });
    else window.prompt('아래 내용을 복사하세요', text);
  }
  function fmtDeadline(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''));
    if (!m) return s || '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number(m[2]) + '월 ' + Number(m[3]) + '일(' + '일월화수목금토'[d.getDay()] + ')';
  }
  function partLetter(p) { return String(p).split('.')[0].trim(); }
  function partTitle(p) { var i = String(p).indexOf('.'); return i >= 0 ? String(p).slice(i + 1).trim() : String(p); }
  function isOther(opt) { return /기타/.test(opt); }
  function isNone(opt) { return /^(해당 없음|특별히 없음|없음|상관없음)$/.test(opt); }
  function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }

  // ───────────────────────── 서버 호출 ─────────────────────────
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (window.__MOCK__) return window.__mockCall(fn, args);
    var api = window.GAS_URL;
    if (!api) return Promise.reject(new Error('config.js 에 Apps Script 주소(GAS_URL)가 비어 있습니다. README 의 배포 순서를 따라 주세요.'));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 25000);
    return fetch(api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn: fn, args: args }), signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) { throw new Error('서버 응답을 읽지 못했습니다. Apps Script 배포(액세스: 모든 사용자)를 확인해 주세요.'); }
        if (!j.ok) throw new Error(j.error || '알 수 없는 오류');
        return j.result;
      })
      .catch(function (e) { if (e && e.name === 'AbortError') throw new Error('서버 응답이 없습니다. 잠시 뒤 다시 시도해 주세요.'); throw e; })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // ───────────────────────── 상태 ─────────────────────────
  var S = {
    meta: null, sid: null, name: store.get('name', null), answers: {}, status: null, loaded: false, loading: false, part: 0, showDone: false, saveErr: null,
    results: null, resultsErr: null, resTab: null, sel: null, present: false, slide: 0,
    admin: sess.get('admin', ''), adminData: null, tagFilter: {}
  };
  var sidParam = new URLSearchParams(location.search).get('survey') || '';
  function cfg() { return (S.meta && S.meta.config) || {}; }
  function members() { return (S.meta && S.meta.members) || []; }
  function questions() { return (S.meta && S.meta.questions) || []; }
  function parts() {
    var out = [], map = {};
    questions().forEach(function (q) {
      if (!map[q.part]) { map[q.part] = { key: q.part, letter: partLetter(q.part), title: partTitle(q.part), questions: [] }; out.push(map[q.part]); }
      map[q.part].questions.push(q);
    });
    return out;
  }
  function anonPart(p) { return p.questions.length && p.questions.every(function (q) { return q.type === 'name' || !q.show_names; }) && p.questions.some(function (q) { return q.type !== 'name'; }); }

  // 응답 값 읽기·쓰기 — S.answers[qid][row_key] = 문자열 또는 배열
  function ans(qid) { return S.answers[qid] = S.answers[qid] || {}; }
  function getV(qid, rk) { var a = S.answers[qid], v = a && a[rk]; if (Array.isArray(v)) return v[0] || ''; return v || ''; }
  function getA(qid, rk) { var a = S.answers[qid], v = a && a[rk]; if (!v) return []; return Array.isArray(v) ? v.slice() : [v]; }
  function setV(qid, rk, v) {
    var a = ans(qid);
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) delete a[rk]; else a[rk] = v;
    if (!Object.keys(a).length) delete S.answers[qid];
    saveDraft();
  }
  function draftKey() { return 'draft.' + S.sid + '.' + S.name; }
  function saveDraft() {
    var p = parts()[S.part]; if (!p || !S.name) return;
    var sub = {}; p.questions.forEach(function (q) { if (S.answers[q.qid]) sub[q.qid] = S.answers[q.qid]; });
    store.set(draftKey(), { part: S.part, answers: sub, at: Date.now() });
  }
  function applyDraft() {
    var d = store.get(draftKey(), null); if (!d || typeof d.part !== 'number') return;
    if (d.part < parts().length) { S.part = d.part; Object.keys(d.answers || {}).forEach(function (qid) { S.answers[qid] = d.answers[qid]; }); }
  }
  function clearDraft() { store.del(draftKey()); }

  // ───────────────────────── 부팅·라우팅 ─────────────────────────
  function boot() {
    if (window.__MOCK__) { $('#mockBadge').hidden = false; $('#mockReset').addEventListener('click', function (e) { e.preventDefault(); if (confirm('미리보기 데이터를 지우고 다시 만들까요?')) window.__mockReset(); }); }
    var cached = store.get('meta', null);
    if (cached && cached.config && (!sidParam || cached.config.survey_id === sidParam)) { S.meta = cached; S.sid = cached.config.survey_id; }
    window.addEventListener('hashchange', route);
    route();
    call('apiMeta', sidParam).then(function (m) {
      S.meta = m; S.sid = m.config.survey_id; store.set('meta', m);
      route();
    }).catch(function (e) {
      if (!S.meta) renderError(e); else toast('서버 연결이 느립니다. 저장된 문항으로 계속합니다.');
    });
  }
  function currentRoute() { var h = location.hash.replace(/^#\/?/, ''); return ['survey', 'results', 'admin'].indexOf(h) >= 0 ? h : 'survey'; }
  function route() {
    var r = currentRoute();
    document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('cur', a.getAttribute('data-route') === r); });
    $('#navResults').hidden = !(cfg().results_open === '예' || S.admin);
    document.body.classList.toggle('results-page', r === 'results');
    if (r !== 'results' && S.present) exitPresent(false);
    if (S.meta) $('#brandTitle').textContent = cfg().title || '우리 모임 설문';
    if (r === 'survey') renderSurvey(); else if (r === 'results') renderResults(); else renderAdmin();
  }
  function setMain(nodes) { var m = $('#main'); m.innerHTML = ''; (Array.isArray(nodes) ? nodes : [nodes]).forEach(function (n) { if (n) m.appendChild(n); }); }
  function renderError(e) {
    setMain(el('div', { class: 'card stack' }, [el('h2', { text: '연결하지 못했습니다' }), el('p', { class: 'muted', text: (e && e.message) || String(e) }), el('button', { class: 'btn btn-primary', onclick: function () { location.reload(); } }, ['다시 시도'])]));
  }
  function loadingCard(text) { return el('div', { class: 'card center stack' }, [el('div', { class: 'spinner', style: 'margin:0 auto' }), el('p', { class: 'muted', text: text || '불러오는 중…' })]); }

  // ───────────────────────── 설문 화면 ─────────────────────────
  function renderSurvey() {
    if (!S.meta) return setMain(loadingCard('문항을 불러오는 중…'));
    if (!members().length) return setMain(el('div', { class: 'card stack' }, [el('h2', { text: '명렬이 비어 있습니다' }), el('p', { class: 'muted', text: '구글 시트 members 탭에 회원 이름을 넣으면 설문을 시작할 수 있습니다.' })]));
    if (!S.name || !members().some(function (m) { return m.name === S.name; })) { S.name = null; return renderHome(); }
    if (cfg().survey_open === '아니오' && !S.admin) return renderClosed();
    if (!S.loaded) {
      if (S.loading) return;
      S.loading = true;
      setMain(loadingCard(S.name + ' 님의 응답을 불러오는 중…'));
      call('apiLoad', S.sid, S.name).then(function (r) {
        S.loading = false; S.loaded = true; S.answers = r.answers || {}; S.status = r.status; S.part = 0;
        S.showDone = !!(r.status && r.status.submitted_at);
        applyDraft();
        if (store.get(draftKey(), null)) S.showDone = false;
        renderSurvey();
      }).catch(function (e) { S.loading = false; setMain(el('div', { class: 'card stack' }, [el('h2', { text: '불러오지 못했습니다' }), el('p', { class: 'muted', text: e.message }), el('div', { class: 'row' }, [el('button', { class: 'btn btn-primary', onclick: renderSurvey }, ['다시 시도']), el('button', { class: 'btn', onclick: changeName }, ['다른 이름으로'])])])); });
      return;
    }
    if (S.showDone) return renderDone();
    renderPart();
  }
  function changeName() { S.name = null; S.loaded = false; S.answers = {}; S.status = null; S.showDone = false; store.del('name'); renderSurvey(); }
  function renderHome() {
    var c = cfg(), ps = parts();
    var nodes = [
      el('div', { class: 'card stack' }, [
        el('h1', { text: c.title || '우리 모임 설문' }),
        el('div', { class: 'chips' }, [
          c.deadline ? el('span', { class: 'chip warn', text: '마감 ' + fmtDeadline(c.deadline) }) : null,
          el('span', { class: 'chip', text: ps.length + '개 파트 · ' + questions().filter(function (q) { return q.type !== 'name'; }).length + '문항 · 10~15분' })
        ]),
        c.intro ? el('p', { class: 'muted', text: c.intro }) : null
      ])
    ];
    if (c.survey_open === '아니오') nodes.push(el('div', { class: 'notice warn', text: '설문이 마감되었습니다.' + (c.results_open === '예' ? ' 위의 "결과" 에서 함께 볼 수 있습니다.' : ' 결과는 운영진이 공개하면 볼 수 있습니다.') }));
    nodes.push(el('div', { class: 'card stack' }, [
      el('h2', { text: '이름을 선택해 주세요' }),
      el('p', { class: 'muted small', text: '비밀번호는 없습니다. 이 기기에 이름이 기억되며, 마감 전에는 다시 들어와 답을 고칠 수 있습니다.' }),
      el('div', { class: 'name-grid' }, members().map(function (m) {
        return el('button', { class: 'btn', onclick: function () { S.name = m.name; store.set('name', m.name); S.loaded = false; S.answers = {}; renderSurvey(); } }, [m.name]);
      }))
    ]));
    setMain(nodes);
  }
  function renderClosed() {
    var c = cfg();
    setMain(el('div', { class: 'card stack' }, [
      el('h2', { text: '설문이 마감되었습니다' }),
      el('p', { class: 'muted', text: c.results_open === '예' ? '결과를 함께 볼 수 있습니다.' : '결과는 운영진이 공개하면 같은 주소의 "결과" 에서 볼 수 있습니다.' }),
      el('div', { class: 'row' }, [c.results_open === '예' ? el('a', { class: 'btn btn-primary', href: '#results' }, ['결과 보기']) : null, el('button', { class: 'btn', onclick: changeName }, ['다른 이름으로'])])
    ]));
  }
  function renderDone() {
    var c = cfg();
    setMain(el('div', { class: 'card stack center' }, [
      el('div', { style: 'font-size:48px' }, ['✅']),
      el('h1', { text: '제출 완료' }),
      el('p', { class: 'muted', text: S.name + ' 님, 고맙습니다. 결과는 마감(' + fmtDeadline(c.deadline) + ') 뒤 전원에게 함께 공개됩니다.' }),
      el('p', { class: 'muted small', text: '마감 전에는 언제든 다시 들어와 답을 고칠 수 있습니다.' }),
      el('div', { class: 'row', style: 'justify-content:center' }, [
        el('button', { class: 'btn', onclick: function () { S.showDone = false; S.part = 0; renderSurvey(); } }, ['응답 수정하기']),
        c.results_open === '예' ? el('a', { class: 'btn btn-primary', href: '#results' }, ['결과 보기']) : null
      ]),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: changeName }, ['다른 이름으로 응답하기'])
    ]));
  }

  function renderPart() {
    var ps = parts(), p = ps[S.part] || ps[0], N = ps.length;
    var nodes = [];
    nodes.push(el('div', { class: 'progress' }, [
      el('div', { class: 'label' }, [el('span', { text: '파트 ' + (S.part + 1) + ' / ' + N }), el('span', { text: S.name + ' 님' })]),
      el('div', { class: 'track' }, [el('div', { class: 'fill', style: 'width:' + Math.round((S.part + 1) / N * 100) + '%' })])
    ]));
    nodes.push(el('h2', { class: 'part-title', text: p.letter + '. ' + p.title }));
    if (anonPart(p)) nodes.push(el('div', { class: 'notice', text: '이 파트의 답은 결과 화면에 이름 없이 집계만 표시됩니다. 솔직하게 적어 주세요.' }));
    if (S.saveErr) nodes.push(el('div', { class: 'notice danger' }, ['저장하지 못했습니다: ' + S.saveErr.msg + ' ', el('button', { class: 'btn btn-sm', style: 'margin-left:8px', onclick: function () { var a = S.saveErr.args; S.saveErr = null; goPart(a[0], a[1]); } }, ['다시 시도'])]));
    var list = el('div', { class: 'stack' }, p.questions.map(renderQ));
    nodes.push(list);
    var last = S.part === N - 1;
    nodes.push(el('div', { class: 'survey-nav' }, [
      el('button', { class: 'btn', disabled: S.part === 0, onclick: function () { goPart(-1, false); } }, ['이전']),
      el('button', { class: 'btn btn-primary', onclick: function () { goPart(1, last); } }, [last ? '제출하기' : '다음'])
    ]));
    nodes.push(el('div', { class: 'saved-note', text: '파트를 넘길 때마다 자동 저장됩니다. 중간에 끊겨도 다시 들어오면 이어서 할 수 있습니다.' }));
    setMain(nodes);
  }

  function renderQ(q) {
    var wrap = el('div', { class: 'q', 'data-qid': q.qid });
    var body;
    if (q.type === 'name') {
      wrap.appendChild(el('div', { class: 'q-head' }, [el('span', { class: 'q-num', text: q.qid }), el('div', { class: 'q-text' }, [q.text])]));
      if (q.help) wrap.appendChild(el('div', { class: 'q-help', text: q.help }));
      wrap.appendChild(el('div', { class: 'name-card' }, [el('span', { class: 'nm', text: S.name }), el('button', { class: 'btn btn-sm', onclick: changeName }, ['다른 이름으로'])]));
      return wrap;
    }
    wrap.appendChild(el('div', { class: 'q-head' }, [el('span', { class: 'q-num', text: q.qid }), el('div', { class: 'q-text' }, [q.text, q.required ? el('span', { class: 'req', text: '*' }) : null])]));
    if (q.help) wrap.appendChild(el('div', { class: 'q-help', text: q.help }));
    var refresh = function () { var n = renderQ(q); wrap.replaceWith(n); };
    if (q.type === 'single') body = renderSingle(q, refresh);
    else if (q.type === 'multi') body = renderMulti(q, refresh);
    else if (q.type === 'scale') body = renderScale(q, refresh);
    else if (q.type === 'rank') body = renderRank(q, refresh);
    else if (q.type === 'grid_scale') body = renderGridScale(q, refresh);
    else if (q.type === 'grid_check') body = renderGridCheck(q, refresh);
    else body = renderText(q);
    wrap.appendChild(body);
    if (q.extra_text) {
      wrap.appendChild(el('div', { class: 'other-box', style: 'margin-top:12px' }, [
        el('label', { class: 'field', text: q.extra_text }),
        el('textarea', { rows: 2, placeholder: '자유롭게 적어 주세요 (선택)', oninput: function (e) { setV(q.qid, '_extra', e.target.value); } }, [getV(q.qid, '_extra')])
      ]));
    }
    return wrap;
  }
  function otherBox(q) {
    return el('div', { class: 'other-box' }, [el('input', { type: 'text', placeholder: '기타 내용을 적어 주세요', value: getV(q.qid, '_other'), oninput: function (e) { setV(q.qid, '_other', e.target.value); } })]);
  }
  function renderSingle(q, refresh) {
    var cur = getV(q.qid, '_');
    var list = el('div', { class: 'opts' }, q.options.map(function (opt) {
      return el('button', { type: 'button', class: 'opt' + (cur === opt ? ' on' : ''), onclick: function () { setV(q.qid, '_', cur === opt ? '' : opt); if (cur === opt || !isOther(opt)) setV(q.qid, '_other', ''); refresh(); } }, [el('span', { class: 'mark' }), el('span', {}, [opt])]);
    }));
    var box = el('div', {}, [list]);
    if (cur && isOther(cur)) box.appendChild(otherBox(q));
    return box;
  }
  function renderMulti(q, refresh) {
    var cur = getA(q.qid, '_');
    var list = el('div', { class: 'opts' }, q.options.map(function (opt) {
      var on = cur.indexOf(opt) >= 0;
      return el('button', { type: 'button', class: 'opt box' + (on ? ' on' : ''), onclick: function () {
        var next;
        if (on) next = cur.filter(function (x) { return x !== opt; });
        else if (isNone(opt)) next = [opt];
        else {
          next = cur.filter(function (x) { return !isNone(x); });
          if (q.max_select && next.length >= q.max_select) { toast('최대 ' + q.max_select + '개까지 고를 수 있어요'); return; }
          next.push(opt);
        }
        setV(q.qid, '_', next);
        if (!next.some(isOther)) setV(q.qid, '_other', '');
        refresh();
      } }, [el('span', { class: 'mark' }), el('span', {}, [opt])]);
    }));
    var box = el('div', {}, [q.max_select ? el('p', { class: 'tiny muted', text: '최대 ' + q.max_select + '개 · ' + cur.length + '개 선택' }) : null, list]);
    if (cur.some(isOther)) box.appendChild(otherBox(q));
    return box;
  }
  function renderScale(q, refresh) {
    var cur = Number(getV(q.qid, '_')) || 0;
    var labels = q.options.length === 5 ? q.options : ['전혀 아니다', '', '', '', '매우 그렇다'];
    return el('div', {}, [
      el('div', { class: 'scale' }, [1, 2, 3, 4, 5].map(function (v) { return el('button', { type: 'button', class: 'btn' + (cur === v ? ' on' : ''), title: labels[v - 1], onclick: function () { setV(q.qid, '_', cur === v ? '' : String(v)); refresh(); } }, [String(v)]); })),
      el('div', { class: 'scale-ends' }, [el('span', { text: '1 ' + (labels[0] || '') }), el('span', { text: '5 ' + (labels[4] || '') })]),
      cur ? el('p', { class: 'small muted', style: 'margin-top:8px', text: '선택: ' + cur + '점' + (labels[cur - 1] ? ' · ' + labels[cur - 1] : '') }) : null
    ]);
  }
  function renderRank(q, refresh) {
    var rows = q.rows.length ? q.rows : ['1순위', '2순위', '3순위'];
    var chosen = rows.map(function (r) { return getV(q.qid, r); });
    var box = el('div', {}, rows.map(function (r, i) {
      var sel = el('select', { onchange: function (e) { setV(q.qid, r, e.target.value); if (!rows.some(function (rr) { return isOther(getV(q.qid, rr)); })) setV(q.qid, '_other', ''); refresh(); } }, [el('option', { value: '', text: '선택' })].concat(q.options.map(function (opt) {
        var usedElsewhere = chosen.some(function (c, j) { return j !== i && c === opt; });
        return el('option', { value: opt, text: opt + (usedElsewhere && chosen[i] !== opt ? ' (다른 순위에서 선택)' : ''), selected: chosen[i] === opt });
      })));
      return el('div', { class: 'rank-row' }, [el('span', { class: 'rlabel', text: r }), sel]);
    }));
    if (chosen.some(isOther)) box.appendChild(otherBox(q));
    return box;
  }
  function renderGridScale(q, refresh) {
    var labels = q.options.length === 5 ? q.options : ['1', '2', '3', '4', '5'];
    return el('div', { class: 'grid-scale' }, [
      el('div', { class: 'scale-ends', style: 'margin:0 0 8px' }, [el('span', { text: '1 ' + labels[0] }), el('span', { text: '5 ' + labels[4] })])
    ].concat(q.rows.map(function (r) {
      var cur = Number(getV(q.qid, r)) || 0;
      return el('div', { class: 'grow-row' }, [
        el('div', { class: 'rlabel', text: r + (cur ? ' · ' + cur + '점' : '') }),
        el('div', { class: 'scale' }, [1, 2, 3, 4, 5].map(function (v) { return el('button', { type: 'button', class: 'btn' + (cur === v ? ' on' : ''), onclick: function () { setV(q.qid, r, cur === v ? '' : String(v)); refresh(); } }, [String(v)]); }))
      ]);
    })));
  }
  function renderGridCheck(q, refresh) {
    var none = !!getV(q.qid, '_none');
    var tbl = el('table', { class: 'gc' });
    tbl.appendChild(el('thead', {}, [el('tr', {}, [el('th', { class: 'rowh' })].concat(q.options.map(function (c) { return el('th', { text: c }); })))]));
    tbl.appendChild(el('tbody', {}, q.rows.map(function (r) {
      var cur = getA(q.qid, r);
      return el('tr', {}, [el('th', { class: 'rowh', text: r })].concat(q.options.map(function (c) {
        var on = cur.indexOf(c) >= 0;
        return el('td', {}, [el('button', { type: 'button', class: on ? 'on' : '', disabled: none, 'aria-label': r + ' ' + c, onclick: function () {
          var next = on ? cur.filter(function (x) { return x !== c; }) : cur.concat([c]);
          setV(q.qid, r, next); setV(q.qid, '_none', ''); refresh();
        } }, [on ? '✓' : ''])]);
      })));
    })));
    var box = el('div', {}, [tbl]);
    if (q.none_label) box.appendChild(el('div', { class: 'opts', style: 'margin-top:10px' }, [el('button', { type: 'button', class: 'opt box' + (none ? ' on' : ''), onclick: function () {
      if (none) setV(q.qid, '_none', ''); else { q.rows.forEach(function (r) { setV(q.qid, r, []); }); setV(q.qid, '_none', '1'); }
      refresh();
    } }, [el('span', { class: 'mark' }), el('span', {}, [q.none_label])])]));
    return box;
  }
  function renderText(q) {
    return el('textarea', { rows: 3, placeholder: '자유롭게 적어 주세요', oninput: function (e) { setV(q.qid, '_', e.target.value); } }, [getV(q.qid, '_')]);
  }

  function validatePart(p) {
    var errs = [];
    p.questions.forEach(function (q) {
      var msg = '';
      if (q.type === 'rank') {
        var seen = {}, rows = q.rows.length ? q.rows : ['1순위', '2순위', '3순위'];
        rows.forEach(function (r) { var v = getV(q.qid, r); if (v) { if (seen[v]) msg = '같은 항목을 두 순위에 골랐어요. 하나로 정해 주세요.'; seen[v] = 1; } });
      }
      if (!msg && q.required) {
        var ok = true;
        if (q.type === 'name') ok = !!S.name;
        else if (q.type === 'multi') ok = getA(q.qid, '_').length > 0;
        else if (q.type === 'rank') ok = !!getV(q.qid, (q.rows[0] || '1순위'));
        else if (q.type === 'grid_scale') ok = q.rows.some(function (r) { return !!getV(q.qid, r); });
        else if (q.type === 'grid_check') ok = !!getV(q.qid, '_none') || q.rows.some(function (r) { return getA(q.qid, r).length > 0; });
        else ok = !!getV(q.qid, '_');
        if (!ok) msg = '이 문항은 꼭 답해 주세요.';
      }
      if (msg) errs.push({ qid: q.qid, msg: msg });
    });
    return errs;
  }
  function goPart(delta, submit) {
    var ps = parts(), cur = ps[S.part];
    document.querySelectorAll('.q.invalid').forEach(function (n) { n.classList.remove('invalid'); var e = $('.q-err', n); if (e) e.remove(); });
    if (delta > 0) {
      var errs = validatePart(cur);
      if (errs.length) {
        errs.forEach(function (e) { var n = $('.q[data-qid="' + e.qid + '"]'); if (n) { n.classList.add('invalid', 'shake'); n.appendChild(el('div', { class: 'q-err', text: e.msg })); } });
        var first = $('.q.invalid'); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(errs[0].msg); return;
      }
    }
    var payload = {};
    cur.questions.forEach(function (q) { if (q.type !== 'name') payload[q.qid] = S.answers[q.qid] || {}; });
    overlay(true, submit ? '제출하는 중…' : '저장하는 중…');
    call('apiSave', S.sid, S.name, cur.key, payload, !!submit, S.admin).then(function (r) {
      overlay(false); S.status = r.status; S.saveErr = null; clearDraft();
      if (submit) S.showDone = true; else S.part = Math.max(0, Math.min(ps.length - 1, S.part + delta));
      window.scrollTo(0, 0); renderSurvey();
    }).catch(function (e) {
      overlay(false); S.saveErr = { msg: e.message, args: [delta, submit] }; toast('저장하지 못했습니다: ' + e.message, 3500); renderPart(); window.scrollTo(0, 0);
    });
  }

  // ───────────────────────── 결과 화면 ─────────────────────────
  function renderResults() {
    if (!S.meta) return setMain(loadingCard());
    var c = cfg();
    if (c.results_open !== '예' && !S.admin) {
      return setMain(el('div', { class: 'card stack' }, [el('h2', { text: '결과는 아직 공개 전입니다' }), el('p', { class: 'muted', text: '응답 마감(' + fmtDeadline(c.deadline) + ') 뒤 운영진이 공개하면 이 화면에서 전원이 함께 봅니다.' }), el('a', { class: 'btn', href: '#survey' }, ['설문으로'])]));
    }
    if (!S.results) {
      if (S.resultsErr) return setMain(el('div', { class: 'card stack' }, [el('h2', { text: '결과를 불러오지 못했습니다' }), el('p', { class: 'muted', text: S.resultsErr }), el('button', { class: 'btn btn-primary', onclick: function () { S.resultsErr = null; renderResults(); } }, ['다시 시도'])]));
      setMain(loadingCard('결과를 집계하는 중…'));
      call('apiResults', S.sid, S.admin).then(function (r) { S.results = r; if (currentRoute() === 'results') renderResults(); }).catch(function (e) { S.resultsErr = e.message; if (currentRoute() === 'results') renderResults(); });
      return;
    }
    var R = S.results, ps = resultParts(R);
    if (S.present) return renderPresent(R, ps);
    if (!S.resTab || !ps.some(function (p) { return p.key === S.resTab; })) S.resTab = ps[0].key;
    var tab = ps.filter(function (p) { return p.key === S.resTab; })[0];
    var nodes = [];
    nodes.push(el('div', { class: 'row between r-sub', style: 'margin-bottom:10px' }, [
      el('div', { class: 'chips' }, [el('span', { class: 'chip primary', text: '응답 ' + R.submitted.length + ' / ' + R.total + '명' }), S.admin ? el('span', { class: 'chip', text: '운영자 보기' }) : null]),
      el('div', { class: 'row' }, [el('button', { class: 'btn btn-sm', onclick: function () { S.results = null; renderResults(); } }, ['새로고침']), el('button', { class: 'btn btn-sm btn-primary', onclick: enterPresent }, ['발표 모드'])])
    ]));
    nodes.push(el('div', { class: 'tabs' }, ps.map(function (p) { return el('button', { class: 'btn' + (p.key === S.resTab ? ' on' : ''), onclick: function () { S.resTab = p.key; S.sel = null; renderResults(); window.scrollTo(0, 0); } }, [p.short]); })));
    nodes.push(el('div', { class: 'stack' }, tab.slides.map(function (s) { return renderSlide(s, R); })));
    setMain(nodes);
  }
  /** 결과 탭 구성: [현황] + 파트별. 일정 파트는 C1+C3 를 보드 하나로 묶는다. */
  function resultParts(R) {
    var out = [{ key: '_status', short: '현황', title: '응답 현황', slides: [{ kind: 'status' }] }];
    var byPart = {}, order = [];
    R.questions.forEach(function (q) { if (q.type === 'name') return; if (!byPart[q.part]) { byPart[q.part] = []; order.push(q.part); } byPart[q.part].push(q); });
    order.forEach(function (p) {
      var qs = byPart[p], slides = [];
      var c1 = qs.filter(function (q) { return q.qid === 'C1' && q.type === 'multi'; })[0];
      var c3 = qs.filter(function (q) { return q.qid === 'C3' && q.type === 'grid_check'; })[0];
      if (c1 && c3) slides.push({ kind: 'board', c1: c1, c3: c3 });
      qs.forEach(function (q) { if (c1 && c3 && (q === c1 || q === c3)) return; slides.push({ kind: 'q', q: q }); });
      out.push({ key: p, short: partLetter(p) + '. ' + partTitle(p), title: p, slides: slides });
    });
    return out;
  }
  function nameList(names, cls) {
    if (!names || !names.length) return null;
    return el('span', { class: cls || '' }, names.map(function (n, i) { return el('span', { class: n === S.name ? 'me' : '', text: n + (i < names.length - 1 ? ', ' : '') }); }));
  }
  function renderSlide(s, R) {
    if (s.kind === 'status') return renderStatusCard(R);
    if (s.kind === 'board') return renderBoard(s.c1, s.c3, R);
    return renderResultQ(s.q, R);
  }
  function renderStatusCard(R) {
    function col(title, names, cls) { return el('div', { class: 'status-col' }, [el('h4', { text: title + ' ' + names.length + '명' }), names.length ? el('div', { class: 'chips' }, names.map(function (n) { return el('span', { class: 'chip ' + cls, text: n }); })) : el('p', { class: 'tiny muted', text: '없음' })]); }
    return el('div', { class: 'card stack' }, [
      el('div', { class: 'r-head' }, [el('div', { class: 'r-text', text: '응답 현황' }), el('span', { class: 'r-n', text: R.deadline ? '마감 ' + fmtDeadline(R.deadline) : '' })]),
      el('div', { class: 'bignum' }, [String(R.submitted.length), el('small', { text: ' / ' + R.total + '명 제출' })]),
      el('div', { class: 'status-cols' }, [col('제출', R.submitted, 'ok'), col('진행 중', R.in_progress, 'warn'), col('미응답', R.not_started, '')]),
      el('p', { class: 'tiny muted', text: '집계 시각 ' + R.generated_at })
    ]);
  }
  function qHead(q, R, extra) {
    return el('div', { class: 'r-head' }, [el('span', { class: 'q-num', text: q.qid }), el('div', { class: 'r-text', text: q.text }), el('span', { class: 'r-n', text: (extra || '') + q.n + '/' + R.total })]);
  }
  function anonNote(q) { return q.show_names ? null : el('div', { class: 'anon', text: '이름 없이 집계만 표시합니다' }); }
  function cardsBlock(title, cards, q) {
    if (!cards || !cards.length) return null;
    return el('div', { style: 'margin-top:14px' }, [el('h4', { class: 'muted', style: 'font-size:14px;margin-bottom:6px', text: title }), el('div', { class: 'cards' }, cards.map(function (c) { return renderTextCard(c, q); }))]);
  }
  var TAGS = ['일정', '형식', '소그룹', '역할', '기타'];
  function renderTextCard(c, q) {
    var node = el('div', { class: 'tcard' }, [el('div', { text: c.text })]);
    var foot = el('div', { class: 'tagrow' }, [c.name ? el('span', { class: 'who', text: c.name }) : null, c.tag && !S.admin ? el('span', { class: 'tag', text: c.tag }) : null]);
    if (S.admin) {
      foot.appendChild(el('select', { onchange: function (e) {
        var tag = e.target.value;
        call('apiAdminTag', S.admin, S.sid, q.qid, c.cid, tag).then(function () { c.tag = tag; toast(tag ? '태그 "' + tag + '" 저장' : '태그 지움'); }).catch(function (err) { toast(err.message); });
      } }, [el('option', { value: '', text: '태그 없음', selected: !c.tag })].concat(TAGS.map(function (t) { return el('option', { value: t, text: t, selected: c.tag === t }); }))));
    }
    if (foot.childNodes.length) node.appendChild(foot);
    return node;
  }
  function bars(items, total, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, items.map(function (i) { return opts.value ? opts.value(i) : i.count; }).concat([0]));
    return el('div', { class: 'bars' }, items.map(function (it) {
      var v = opts.value ? opts.value(it) : it.count;
      var cls = 'bar' + (v > 0 && v === max ? ' top' : '') + (opts.onClick ? ' clickable' : '') + (opts.selected === it.label ? ' sel' : '');
      var node = el('div', { class: cls, onclick: opts.onClick ? function () { opts.onClick(it); } : null }, [
        el('span', { class: 'bl', text: it.label }),
        el('span', { class: 'bv', text: opts.valueText ? opts.valueText(it) : (it.count + '명 · ' + pct(it.count, total) + '%') }),
        el('div', { class: 'bt' }, [el('div', { class: 'bf', style: 'width:' + (max ? Math.round(v / max * 100) : 0) + '%' })]),
        opts.names && opts.names(it) ? el('div', { class: 'bn' }, [opts.names(it)]) : null
      ]);
      return node;
    }));
  }
  function renderResultQ(q, R) {
    var body = [], total = q.n || 0;
    if (q.type === 'single' || q.type === 'multi') {
      var items = q.items.slice();
      if (q.type === 'multi') items.sort(function (a, b) { return b.count - a.count; });
      body.push(bars(items, total, { names: q.show_names ? function (it) { return nameList(it.names); } : null }));
      body.push(cardsBlock('기타 내용', q.others, q));
    } else if (q.type === 'scale') {
      var maxc = Math.max.apply(null, q.dist.map(function (d) { return d.count; }).concat([1]));
      body.push(el('div', { class: 'avg' }, [el('span', { class: 'big', text: q.avg === null ? '–' : q.avg.toFixed(2) }), el('span', { class: 'of', text: '/ 5 평균' })]));
      body.push(el('div', { class: 'dist' }, q.dist.map(function (d) {
        return el('div', { class: 'col' + (d.count === maxc && d.count ? ' top' : '') }, [
          el('span', { class: 'cnt', text: String(d.count) }),
          el('div', { class: 'stick', style: 'height:' + Math.max(4, Math.round(d.count / maxc * 90)) + 'px' }),
          el('span', { class: 'lb', text: d.value + ' ' + (d.label || '') }),
          q.show_names && d.names.length ? el('span', { class: 'nm', text: d.names.join(', ') }) : null
        ]);
      })));
    } else if (q.type === 'rank') {
      body.push(el('p', { class: 'tiny muted', text: '1순위 ' + q.rows.length + '점 … ' + q.rows.length + '순위 1점으로 합산. 1순위 득표 수를 함께 표시합니다.' }));
      body.push(bars(q.items, total, {
        value: function (it) { return it.score; },
        valueText: function (it) { return it.score + '점 · 1순위 ' + it.first + '명'; },
        names: q.show_names ? function (it) {
          if (!it.names.length) return null;
          var byRank = {}; it.names.forEach(function (n) { (byRank[n.label] = byRank[n.label] || []).push(n.name); });
          return el('span', { class: 'rank-names' }, q.rows.filter(function (lab) { return byRank[lab]; }).map(function (lab, i) { return el('span', {}, [(i ? ' · ' : ''), el('b', { text: lab + ' ' }), nameList(byRank[lab])]); }));
        } : null
      }));
      body.push(cardsBlock('기타 내용', q.others, q));
    } else if (q.type === 'grid_scale') {
      body.push(bars(q.rowsAgg, total, {
        value: function (r) { return r.avg || 0; },
        valueText: function (r) { return r.avg === null ? '–' : r.avg.toFixed(2) + ' / 5 · ' + r.count + '명'; }
      }));
      body.push(cardsBlock(q.extra_text || '추가 의견', q.extras, q));
    } else if (q.type === 'grid_check') {
      body.push(renderHeat(q, null, R));
      if (q.none_label) body.push(el('p', { class: 'small muted', style: 'margin-top:8px' }, [q.none_label + ': ' + q.none.count + '명 ', q.show_names ? nameList(q.none.names, 'tiny') : null]));
    } else if (q.type === 'text') {
      body.push(renderTextCards(q));
    }
    if (q.extra_text && q.type !== 'grid_scale') body.push(cardsBlock(q.extra_text, q.extras, q));
    return el('div', { class: 'card' }, [qHead(q, R), anonNote(q)].concat(body));
  }
  function renderTextCards(q) {
    var cards = q.cards || [];
    if (!cards.length) return el('p', { class: 'muted', text: '아직 답이 없습니다.' });
    var tags = []; cards.forEach(function (c) { if (c.tag && tags.indexOf(c.tag) < 0) tags.push(c.tag); });
    var f = S.tagFilter[q.qid] || '';
    var box = el('div', {});
    if (tags.length) box.appendChild(el('div', { class: 'chips', style: 'margin-bottom:10px' }, [el('button', { class: 'btn btn-sm' + (!f ? ' on' : ''), onclick: function () { S.tagFilter[q.qid] = ''; renderResults(); } }, ['전체 ' + cards.length])].concat(tags.map(function (t) { return el('button', { class: 'btn btn-sm' + (f === t ? ' on' : ''), onclick: function () { S.tagFilter[q.qid] = t; renderResults(); } }, [t + ' ' + cards.filter(function (c) { return c.tag === t; }).length]); }))));
    box.appendChild(el('div', { class: 'cards' }, cards.filter(function (c) { return !f || c.tag === f; }).map(function (c) { return renderTextCard(c, q); })));
    return box;
  }
  function heatClass(count, max) { if (!count) return ''; var r = count / Math.max(max, 1); return r > .75 ? 'h4' : r > .5 ? 'h3' : r > .25 ? 'h2' : 'h1'; }
  function renderHeat(q, hlCol, R) {
    var max = 0; q.cells.forEach(function (row) { row.forEach(function (c) { max = Math.max(max, c.count); }); });
    var tbl = el('table', { class: 'heat' });
    tbl.appendChild(el('thead', {}, [el('tr', {}, [el('th', { class: 'rowh' })].concat(q.options.map(function (c, j) { return el('th', { class: j === hlCol ? 'hl' : '', text: c }); })))]));
    tbl.appendChild(el('tbody', {}, q.rows.map(function (r, i) {
      return el('tr', {}, [el('th', { class: 'rowh', text: r })].concat(q.cells[i].map(function (c, j) {
        return el('td', { class: heatClass(c.count, max) + (j === hlCol ? ' hl' : '') }, [String(c.count), q.show_names && c.names.length ? el('span', { class: 'nm', text: c.names.join(' ') }) : null]);
      })));
    })));
    return tbl;
  }
  /** 일정 조율 보드: C1(가능 시간대) 막대 + C3(정기 불가) 격자. 시간대를 누르면 그 요일의 열을 강조하고 주별 가능 인원을 계산한다. */
  function renderBoard(c1, c3, R) {
    var sel = S.sel;
    var selItem = sel ? c1.items.filter(function (i) { return i.label === sel; })[0] : null;
    var col = -1;
    if (sel) { var day = sel.slice(0, 3); c3.options.forEach(function (o, j) { if (col < 0 && o.indexOf(day) === 0) col = j; }); }
    var left = el('div', { class: 'card' }, [
      qHead(c1, R), anonNote(c1),
      bars(c1.items, c1.n, { onClick: function (it) { S.sel = S.sel === it.label ? null : it.label; renderResults(); }, selected: sel, names: c1.show_names ? function (it) { return nameList(it.names); } : null }),
      el('p', { class: 'board-tip', text: '시간대를 누르면 오른쪽 격자에서 그 요일에 정기적으로 못 오는 회원이 강조됩니다.' })
    ]);
    var rightBody = [qHead(c3, R), anonNote(c3), renderHeat(c3, col, R)];
    if (c3.none_label) rightBody.push(el('p', { class: 'small muted', style: 'margin-top:8px' }, [c3.none_label + ': ' + c3.none.count + '명 ', c3.show_names ? nameList(c3.none.names, 'tiny') : null]));
    if (selItem && col >= 0) {
      var avail = selItem.names || [], lines = [], best = -1;
      var weekly = c3.rows.map(function (r, i) {
        var cell = c3.cells[i][col];
        var blocked = c1.show_names ? cell.names.filter(function (n) { return avail.indexOf(n) >= 0; }) : [];
        var can = c1.show_names ? avail.length - blocked.length : selItem.count - cell.count;
        best = Math.max(best, can);
        return { row: r, can: can, blocked: blocked };
      });
      lines.push(el('div', { class: 'strong', text: sel + ' 가능 ' + selItem.count + '명 → 주별로 보면' }));
      weekly.forEach(function (w) { lines.push(el('div', { text: w.row + ' ' + w.can + '명' + (w.can === best ? ' ★' : '') + (w.blocked.length ? ' (못 오는 사람: ' + w.blocked.join(', ') + ')' : '') })); });
      rightBody.push(el('div', { class: 'best' }, lines));
    }
    var right = el('div', { class: 'card' }, rightBody);
    return el('div', { class: 'board' }, [left, right]);
  }

  // ───────────────────────── 발표 모드 ─────────────────────────
  function enterPresent() { S.present = true; S.slide = 0; document.body.classList.add('present'); document.addEventListener('keydown', presentKeys); renderResults(); window.scrollTo(0, 0); }
  function exitPresent(rerender) { S.present = false; document.body.classList.remove('present'); document.removeEventListener('keydown', presentKeys); var b = $('#presentBar'); if (b) b.remove(); if (rerender !== false) renderResults(); }
  function presentKeys(e) {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); moveSlide(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); moveSlide(-1); }
    else if (e.key === 'Escape') exitPresent();
  }
  function allSlides(ps) { var out = []; ps.forEach(function (p) { p.slides.forEach(function (s) { out.push({ slide: s, part: p }); }); }); return out; }
  function moveSlide(d) { var n = allSlides(resultParts(S.results)).length; S.slide = Math.max(0, Math.min(n - 1, S.slide + d)); S.sel = null; renderResults(); window.scrollTo(0, 0); }
  function renderPresent(R, ps) {
    var list = allSlides(ps), cur = list[S.slide] || list[0];
    setMain([
      el('div', { class: 'row between', style: 'margin-bottom:10px' }, [el('span', { class: 'chip primary', text: cur.part.title === '응답 현황' ? '응답 현황' : cur.part.short }), el('span', { class: 'chip', text: '응답 ' + R.submitted.length + ' / ' + R.total + '명' })]),
      renderSlide(cur.slide, R),
      el('div', { class: 'present-space' })
    ]);
    var old = $('#presentBar'); if (old) old.remove();
    document.body.appendChild(el('div', { class: 'present-bar', id: 'presentBar' }, [
      el('button', { class: 'btn', onclick: function () { moveSlide(-1); } }, ['◀ 이전']),
      el('span', { class: 'pos', text: (S.slide + 1) + ' / ' + list.length + ' · ←→ 키로 넘길 수 있어요' }),
      el('div', { class: 'row' }, [el('button', { class: 'btn btn-sm', onclick: function () { exitPresent(); } }, ['나가기']), el('button', { class: 'btn btn-primary', onclick: function () { moveSlide(1); } }, ['다음 ▶'])])
    ]));
  }

  // ───────────────────────── 운영자 화면 ─────────────────────────
  function renderAdmin() {
    if (!S.admin) {
      var inp = el('input', { type: 'password', placeholder: '운영자 코드', autocomplete: 'off' });
      var form = el('form', { class: 'card stack', onsubmit: function (e) {
        e.preventDefault(); var code = inp.value.trim(); if (!code) return;
        overlay(true, '확인하는 중…');
        call('apiAdminStatus', code, S.sid).then(function (r) { overlay(false); S.admin = code; sess.set('admin', code); S.adminData = r; S.results = null; route(); }).catch(function (err) { overlay(false); toast(err.message); });
      } }, [el('h2', { text: '운영자' }), el('p', { class: 'muted small', text: '구글 시트 config 탭의 admin_code 값을 넣어 주세요.' }), inp, el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, ['들어가기'])]);
      return setMain(form);
    }
    if (!S.adminData) {
      setMain(loadingCard('응답 현황을 불러오는 중…'));
      call('apiAdminStatus', S.admin, S.sid).then(function (r) { S.adminData = r; if (currentRoute() === 'admin') renderAdmin(); }).catch(function (e) { S.admin = ''; sess.del('admin'); toast(e.message); renderAdmin(); });
      return;
    }
    var D = S.adminData, c = D.config;
    var submitted = D.members.filter(function (m) { return m.submitted_at; }), started = D.members.filter(function (m) { return !m.submitted_at && m.started_at; }), none = D.members.filter(function (m) { return !m.started_at; });
    function setCfg(key, value, msg) { overlay(true, '저장하는 중…'); call('apiAdminSet', S.admin, key, value).then(function (pub) { overlay(false); D.config = pub; if (S.meta) { S.meta.config = pub; store.set('meta', S.meta); } S.results = null; toast(msg || '저장했습니다'); renderAdmin(); }).catch(function (e) { overlay(false); toast(e.message); }); }
    function sw(key, label, onText, offText) {
      var on = c[key] === '예';
      return el('div', { class: 'switch' }, [el('div', {}, [el('div', { class: 'lab', text: label }), el('div', { class: 'st', text: on ? onText : offText })]), el('button', { class: 'btn btn-sm' + (on ? ' btn-danger' : ' btn-primary'), onclick: function () { if (confirm((on ? offText : onText) + ' 상태로 바꿀까요?')) setCfg(key, on ? '아니오' : '예'); } }, [on ? '끄기' : '켜기'])]);
    }
    var titleInp = el('input', { type: 'text', value: c.title || '' }), dlInp = el('input', { type: 'date', value: c.deadline || '' });
    var nodes = [];
    if (!c.admin_code_set) nodes.push(el('div', { class: 'notice danger', text: '운영자 코드가 기본값(1234)입니다. 구글 시트 config 탭의 admin_code 를 꼭 바꿔 주세요.' }));
    nodes.push(el('div', { class: 'card stack' }, [
      el('div', { class: 'row between' }, [el('h2', { text: '설문 상태' }), el('span', { class: 'chip', text: 'survey_id: ' + c.survey_id })]),
      sw('survey_open', '설문 받기', '열려 있음 — 회원이 응답·수정할 수 있습니다', '닫힘 — 응답을 받지 않습니다'),
      sw('results_open', '결과 공개', '공개 중 — 전원이 "결과" 탭을 볼 수 있습니다', '비공개 — 운영자만 결과를 봅니다'),
      el('div', { class: 'row', style: 'align-items:flex-end' }, [el('div', { class: 'grow' }, [el('label', { class: 'field', text: '설문 제목' }), titleInp]), el('button', { class: 'btn', onclick: function () { setCfg('title', titleInp.value); } }, ['저장'])]),
      el('div', { class: 'row', style: 'align-items:flex-end' }, [el('div', { class: 'grow' }, [el('label', { class: 'field', text: '마감일' }), dlInp]), el('button', { class: 'btn', onclick: function () { setCfg('deadline', dlInp.value); } }, ['저장'])])
    ]));
    nodes.push(el('div', { class: 'card stack' }, [
      el('div', { class: 'row between' }, [el('h2', { text: '응답 현황' }), el('button', { class: 'btn btn-sm', onclick: function () { S.adminData = null; renderAdmin(); } }, ['새로고침'])]),
      el('div', { class: 'bignum' }, [String(submitted.length), el('small', { text: ' / ' + D.members.length + '명 제출 · 진행 중 ' + started.length + ' · 미응답 ' + none.length })]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-sm', onclick: function () { var names = started.concat(none).map(function (m) { return m.name; }); copyText(names.join(', '), '미제출 ' + names.length + '명 이름을 복사했습니다'); } }, ['미제출자 이름 복사']),
        el('button', { class: 'btn btn-sm', onclick: downloadCsv }, ['응답 CSV 내려받기']),
        el('a', { class: 'btn btn-sm btn-primary', href: '#results' }, ['결과 보기'])
      ]),
      el('table', { class: 'st' }, [el('thead', {}, [el('tr', {}, [el('th', { text: '이름' }), el('th', { text: '상태' }), el('th', { text: '마지막 파트' }), el('th', { text: '시각' })])]), el('tbody', {}, D.members.map(function (m) {
        var st = m.submitted_at ? el('span', { class: 'chip ok', text: '제출' }) : m.started_at ? el('span', { class: 'chip warn', text: '진행 중' }) : el('span', { class: 'chip', text: '미응답' });
        return el('tr', {}, [el('td', { text: m.name + (m.role ? ' (' + m.role + ')' : '') }), el('td', {}, [st]), el('td', { class: 'small muted', text: m.last_part ? partLetter(m.last_part) : '' }), el('td', { class: 'tiny muted', text: (m.submitted_at || m.started_at || '').slice(5, 16) })]);
      }))])
    ]));
    var link = location.href.split('#')[0];
    nodes.push(el('div', { class: 'card stack' }, [
      el('h2', { text: '회원에게 보낼 링크' }),
      el('p', { class: 'small muted', text: link }),
      el('div', { class: 'row' }, [el('button', { class: 'btn btn-sm', onclick: function () { copyText(link + '#survey', '설문 링크를 복사했습니다'); } }, ['설문 링크 복사']), el('button', { class: 'btn btn-sm', onclick: function () { copyText(link + '#results', '결과 링크를 복사했습니다'); } }, ['결과 링크 복사'])]),
      el('p', { class: 'tiny muted', text: '문항·선택지는 구글 시트 questions 탭에서 고칩니다. 고친 뒤 회원 화면은 다음 접속 때 새 문항을 받습니다.' }),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: function () { S.admin = ''; sess.del('admin'); S.adminData = null; S.results = null; route(); } }, ['운영자 나가기'])
    ]));
    setMain(nodes);
  }
  function downloadCsv() {
    overlay(true, 'CSV 만드는 중…');
    call('apiAdminCsv', S.admin, S.sid).then(function (r) {
      overlay(false);
      var blob = new Blob(['﻿' + r.csv], { type: 'text/csv;charset=utf-8' });
      var a = el('a', { href: URL.createObjectURL(blob), download: r.filename }); document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }).catch(function (e) { overlay(false); toast(e.message); });
  }

  boot();
})();
