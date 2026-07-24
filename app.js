/* ============================================================
   HealthBoard — 個人用健康管理 PWA  (Phase 1)
   - Firebase (named instance 'health-board') アカウント保持
   - データ: /healthData/$uid/...   (本人のみ read/write)
   ============================================================ */
'use strict';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBFSjOheMb_epwOXCjviAA_FLQFPNiED6g",
  authDomain: "task-board-fbf1e.firebaseapp.com",
  databaseURL: "https://task-board-fbf1e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "task-board-fbf1e",
  storageBucket: "task-board-fbf1e.firebasestorage.app",
  messagingSenderId: "174442724697",
  appId: "1:174442724697:web:06ac83b275780717c06048"
};

// ---- 初期目標 (アプリ内で変更可) ----
const DEFAULT_GOALS = {
  fastHours: 16,        // 16:8 ファスティング
  calorie: 2000,        // 摂取カロリー目安
  protein: 120,         // たんぱく質 g
  fat: 60,              // 脂質 g
  carb: 250,            // 炭水化物 g
  water: 2000,          // 水分 ml
  steps: 12000,         // 歩数
  targetWeight: 0,      // 目標体重 kg (0=未設定)
};

// ---- 既定の筋トレ種目 (ユーザーが追加・編集可) ----
const DEFAULT_EXERCISES = [
  { id:'yt_abs',   name:'YouTube腹筋', type:'check', icon:'📺' },
  { id:'squat',    name:'スクワット',  type:'count', unit:'回', icon:'🦵', step:5, quick:[1,10,20] },
  { id:'tachikoro',name:'立ちコロ',    type:'count', unit:'回', icon:'🎡', step:5, quick:[1,5,10] },
  { id:'situp',    name:'腹筋',        type:'count', unit:'回', icon:'🔥', step:5, quick:[25,50,75] },
];

// ---- サプリ (ホームのチェックで日別記録 days/{date}/supplements/{id}=true) ----
// kcal/PFC はメーカー公表の栄養成分表示 (1日目安量あたり)。チェックONで食事欄に自動追加される
const SUPPLEMENTS = [
  { id:'multi', name:'マルチビタミン', icon:'🌈', hint:'1日3粒・昼食後がおすすめ', dose:'3粒', mealType:'lunch',  kcal:2.7, p:0.2, f:0, c:0.4 },
  { id:'zinc',  name:'亜鉛・マカ',     icon:'⚡', hint:'1日2粒・夕食後がおすすめ', dose:'2粒', mealType:'dinner', kcal:1.5, p:0,   f:0, c:0.3 },
  { id:'vitd',  name:'ビタミンD',      icon:'☀️', hint:'1日1粒・夕食後がおすすめ', dose:'1粒', mealType:'dinner', kcal:0.8, p:0,   f:0, c:0.2 },
];

// 食事写真AI推定 Worker (Phase 2-B)。デプロイ後にURL確定。
const AI_WORKER_URL = "https://healthboard-ai.tomoki-nozawa.workers.dev";

let app, auth, db, uid=null;
let GOALS = {...DEFAULT_GOALS};
let EXERCISES = [...DEFAULT_EXERCISES];
let FOOD_MASTER = {};   // マイ食品マスタ { id: {name,kcal,p,f,c,uses,ts} }
let curTab = 'Home';
let curDate = todayStr();      // 表示中の日付 (YYYY-MM-DD)
let DAY = blankDay();          // 表示中日付のデータ
let unsubDay = null;

/* ===================== utils ===================== */
function todayStr(d){ d=d||new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function shiftDate(str, days){ const [y,m,d]=str.split('-').map(Number); const dt=new Date(y,m-1,d+days); return todayStr(dt); }
function fmtDateLabel(str){
  if(str===todayStr()) return '今日';
  if(str===shiftDate(todayStr(),-1)) return '昨日';
  const [y,m,d]=str.split('-').map(Number); const dt=new Date(y,m-1,d);
  const w=['日','月','火','水','木','金','土'][dt.getDay()];
  return `${m}/${d}(${w})`;
}
function blankDay(){ return { meals:{}, workout:{exercises:{},note:''}, body:{}, supplements:{}, steps:null, sleep:null, water:0, mood:null, active:null }; }
function num(v){ const n=parseFloat(v); return isNaN(n)?0:n; }
function d1(v){ return (Math.round(num(v)*10)/10).toFixed(1); }  // 小数第1位固定 (PFC表示用)
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function uuid(){ return 'x'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); }
function nowHHMM(){ const d=new Date(); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }

let toastT;
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2000);
}

/* ===================== Firebase ===================== */
function initFirebase(){
  app = firebase.initializeApp(FIREBASE_CONFIG, 'health-board');  // 名前付き=他ダッシュボードとセッション分離
  auth = app.auth();
  db = app.database();
  auth.onAuthStateChanged(async (user)=>{
    uid = user ? user.uid : null;
    if(user){
      await loadSettings();
      showApp();
      watchDay();
    } else {
      showLogin();
    }
  });
}
function uref(path){ return db.ref('healthData/'+uid+'/'+path); }

async function loadSettings(){
  try{
    const s = (await uref('settings').once('value')).val() || {};
    GOALS = {...DEFAULT_GOALS, ...(s.goals||{})};
    EXERCISES = (s.exercises && s.exercises.length) ? s.exercises : [...DEFAULT_EXERCISES];
    // クイック追加プリセット・±刻み・既定の並び順を反映 (移行用。未設定の時だけ埋める=ユーザー編集は上書きしない)
    {
      const _q={}, _o={}, _s={}; DEFAULT_EXERCISES.forEach((e,i)=>{ if(e.quick)_q[e.id]=e.quick; if(e.step)_s[e.id]=e.step; _o[e.id]=i; });
      const _sig=x=>JSON.stringify(x.map(e=>[e.id, e.quick||null, e.step||null]));
      const _before=_sig(EXERCISES);
      EXERCISES.forEach(e=>{ if(_q[e.id] && !e.quick) e.quick=_q[e.id]; if(_s[e.id] && e.step==null) e.step=_s[e.id]; });
      EXERCISES.sort((a,b)=>((_o[a.id]??99)-(_o[b.id]??99)));
      if(s.exercises && _sig(EXERCISES)!==_before){ await uref('settings/exercises').set(EXERCISES); }
    }
    if(!s.exercises){ await uref('settings/exercises').set(EXERCISES); }
    if(!s.goals){ await uref('settings/goals').set(GOALS); }
    FOOD_MASTER = s.foodMaster || {};
    // マスタはリアルタイム購読 (シート別 session で追加されても反映)
    uref('settings/foodMaster').on('value', snap=>{ FOOD_MASTER = snap.val()||{}; });
  }catch(e){ console.warn('loadSettings',e); }
}

function watchDay(){
  if(unsubDay){ unsubDay(); unsubDay=null; }
  const ref = uref('days/'+curDate);
  let first=true;
  const cb = ref.on('value', snap=>{
    const d = Object.assign(blankDay(), snap.val()||{});
    d.meals = d.meals||{}; d.workout = d.workout||{exercises:{},note:''};
    d.workout.exercises = d.workout.exercises||{}; d.body = d.body||{};
    // 楽観更新済みの自分の書込エコーなら再描画しない (カウンター連打中のDOM再構築=タップ取りこぼしを防ぐ)
    const same = !first && JSON.stringify(d)===JSON.stringify(DAY);
    first=false; DAY=d;
    if(!same) render();
  });
  unsubDay = ()=>ref.off('value', cb);
}

/* ===================== AUTH UI ===================== */
function showLogin(){ q('#loginView').classList.remove('hidden'); q('#appView').classList.add('hidden'); }
function showApp(){ q('#loginView').classList.add('hidden'); q('#appView').classList.remove('hidden'); updateAcct(); }
function updateAcct(){ q('#acctBtn').textContent = auth.currentUser ? (auth.currentUser.email||'アカウント').split('@')[0] : '…'; }

async function doLogin(){
  const em=q('#loginEmail').value.trim(), pw=q('#loginPass').value, err=q('#loginErr');
  err.textContent='';
  if(!em||!pw){ err.textContent='メールとパスワードを入力してください'; return; }
  try{ await auth.signInWithEmailAndPassword(em,pw); }
  catch(e){ err.textContent = /user-not-found|wrong-password|invalid-credential|invalid-login/.test(e.code||'')
    ? 'メールまたはパスワードが違います' : ('エラー: '+(e.code||e.message)); }
}
async function doSignup(){
  const em=q('#loginEmail').value.trim(), pw=q('#loginPass').value, err=q('#loginErr');
  err.textContent='';
  if(!em||pw.length<6){ err.textContent='メールと6文字以上のパスワードを入力してください'; return; }
  try{ await auth.createUserWithEmailAndPassword(em,pw); toast('アカウントを作成しました'); }
  catch(e){ err.textContent = (e.code||'').includes('email-already')
    ? 'このメールは登録済みです（ログインしてください）' : ('エラー: '+(e.code||e.message)); }
}
async function doReset(){
  const em=q('#loginEmail').value.trim(), err=q('#loginErr'); err.textContent='';
  if(!em){ err.textContent='メールアドレスを入力してから押してください'; return; }
  try{ await auth.sendPasswordResetEmail(em); toast('📮 再設定メールを送信しました'); }
  catch(e){ err.textContent='送信エラー: '+(e.code||e.message); }
}

/* ===================== Fasting calc ===================== */
// 最後の食事時刻からの経過(絶食)時間を計算。表示日が今日なら現在時刻基準。
async function getLastMealTime(){
  // 表示日と前日のmealsから最新のdatetimeを探す
  const days=[curDate, shiftDate(curDate,-1)];
  let latest=null;
  for(const ds of days){
    const snap = ds===curDate ? DAY.meals : ((await uref('days/'+ds+'/meals').once('value')).val()||{});
    for(const k in snap){
      const m=snap[k]; if(!m||!m.at) continue;
      const t = new Date(ds+'T'+(m.at.length===5?m.at:'12:00')+':00');
      if(!latest || t>latest) latest=t;
    }
  }
  return latest;
}

/* ===================== RENDER ===================== */
function render(){
  q('#curDate').textContent = fmtDateLabel(curDate);
  ['Home','Meals','Workout','Body','Stats'].forEach(t=>{
    q('#view'+t).classList.toggle('hidden', t!==curTab);
  });
  if(curTab==='Home') renderHome();
  if(curTab==='Meals') renderMeals();
  if(curTab==='Workout') renderWorkout();
  if(curTab==='Body') renderBody();
  if(curTab==='Stats') renderStats();
}

function mealTotals(){
  let kcal=0,p=0,f=0,c=0,n=0;
  for(const k in DAY.meals){ const m=DAY.meals[k]; kcal+=num(m.kcal); p+=num(m.p); f+=num(m.f); c+=num(m.c); n++; }
  return {kcal,p,f,c,n};
}

/* ---------- 週次サマリー (月曜のみホーム最上部に先週分を表示) ---------- */
let _weeklyCache = { key:null, html:'' };
async function weeklySummaryHtml(){
  if(new Date().getDay()!==1 || curDate!==todayStr()) return '';  // 月曜に今日を表示中のみ
  const start = shiftDate(todayStr(),-7);  // 先週月曜
  if(_weeklyCache.key===start) return _weeklyCache.html;
  const days=[]; for(let i=0;i<7;i++) days.push(shiftDate(start,i));
  const snaps = await Promise.all(days.map(d=>uref('days/'+d).once('value').then(s=>s.val()||{})));
  let kcal=0,p=0,kn=0, st=0,sn=0, suppBoth=0; const ws=[];
  snaps.forEach(v=>{
    let k=0,pp=0,n=0; for(const key in (v.meals||{})){ k+=num(v.meals[key].kcal); pp+=num(v.meals[key].p); n++; }
    if(n){ kcal+=k; p+=pp; kn++; }
    if(v.steps>0){ st+=v.steps; sn++; }
    if(v.body&&v.body.weight!=null) ws.push(v.body.weight);
    const sc = v.supplements ? Object.values(v.supplements).filter(Boolean).length : 0;
    if(sc>=SUPPLEMENTS.length) suppBoth++;
  });
  const lbl=d=>d.slice(5).replace('-','/');
  const wDiff = ws.length>=2 ? ws[ws.length-1]-ws[0] : null;
  const row=(l,v)=>`<div class="row between" style="padding:5px 0"><span class="muted tiny">${l}</span><b class="mono tiny">${v}</b></div>`;
  const html = `<div class="card">
    <div class="tiny muted" style="margin-bottom:4px">📅 先週のふりかえり (${lbl(start)}(月)〜${lbl(shiftDate(start,6))}(日))</div>
    ${row('⚖️ 体重', ws.length? d1(ws[0])+' → '+d1(ws[ws.length-1])+' kg'+(wDiff!=null?` (${wDiff>0?'+':''}${d1(wDiff)})`:'') : '記録なし')}
    ${row('🔥 平均カロリー', kn? Math.round(kcal/kn)+' kcal':'—')}
    ${row('🥩 平均たんぱく質', kn? Math.round(p/kn)+' g':'—')}
    ${row('👣 平均歩数', sn? Math.round(st/sn).toLocaleString()+' 歩':'—')}
    ${row('💊 サプリ (2種とも)', suppBoth+' / 7 日')}
  </div>`;
  _weeklyCache = { key:start, html };
  return html;
}

async function renderHome(){
  const el=q('#viewHome'); const t=mealTotals();
  const weekly = await weeklySummaryHtml();
  const last = await getLastMealTime();
  const ref = curDate===todayStr() ? new Date() : new Date(curDate+'T23:59:59');
  let fastH=0;
  if(last){
    fastH = Math.max(0, (ref - last)/3600000);  // 未来時刻の食事登録直後に負値表示になるのを防ぐ
  }
  const pct = Math.max(0, Math.min(1, fastH/GOALS.fastHours));
  const done = fastH>=GOALS.fastHours;
  const remain = Math.max(0, GOALS.fastHours-fastH);
  const ringColor = done ? 'var(--green)' : 'var(--teal)';
  const circ = 2*Math.PI*88;
  // 達成予定時刻 = 最後の食事 + 目標時間
  const goalTime = last ? new Date(last.getTime()+GOALS.fastHours*3600000) : null;

  el.innerHTML = `
    ${weekly}
    <div class="card">
      <div class="fast-wrap">
        <div class="ring">
          <svg width="200" height="200">
            <circle cx="100" cy="100" r="88" fill="none" stroke="var(--bg2)" stroke-width="16"/>
            <circle cx="100" cy="100" r="88" fill="none" stroke="${ringColor}" stroke-width="16" stroke-linecap="round"
              stroke-dasharray="${circ}" stroke-dashoffset="${circ*(1-pct)}"/>
          </svg>
          <div class="center">
            <div class="t mono">${last?fmtH(fastH):'--'}</div>
            <div class="l">経過 / 目標${GOALS.fastHours}h</div>
          </div>
        </div>
        <div class="fast-state ${done?'fasting':'eating'}">
          ${!last ? '🍽 食事を記録すると計測開始' : done ? '✅ '+GOALS.fastHours+'時間 達成！' : '⏳ 達成まであと '+fmtH(remain)}
        </div>
      </div>
      ${last ? `<div class="fast-detail">
        <div class="fd-row"><span>🎯 ${GOALS.fastHours}時間 達成${done?'時刻':'予定'}</span><b class="${done?'':'hl'}">${fmtDateTime(goalTime)}</b></div>
        <div class="fd-row"><span>⏱ 現在の絶食時間</span><b class="mono">${fmtHM(fastH)}</b></div>
        <div class="fd-row"><span>⌛ 達成まで</span><b class="mono">${done?'達成済み':fmtHM(remain)}</b></div>
        <div class="fd-row"><span>🍽 最後の食事</span><b>${fmtDateTime(last)}</b></div>
      </div>`:''}
    </div>

    <div class="tiles">
      ${tile('🔥 カロリー', Math.round(t.kcal), GOALS.calorie, 'kcal', 'var(--amber)')}
      ${tile('🥩 たんぱく質', d1(t.p), GOALS.protein, 'g', 'var(--rose)')}
      ${tile('👣 歩数', DAY.steps==null?'—':DAY.steps, GOALS.steps, '歩', 'var(--blue)')}
      ${tile('💧 水分', DAY.water||0, GOALS.water, 'ml', 'var(--teal)')}
    </div>

    ${DAY.active!=null ? `<div class="card">
      <div class="row between"><span class="muted tiny">🔥 摂取 ${Math.round(t.kcal)} − 🏃 消費 ${Math.round(num(DAY.active))}(運動)</span>
        <b class="mono" style="color:${(t.kcal-num(DAY.active))<=GOALS.calorie?'var(--green)':'var(--rose)'}">収支 ${Math.round(t.kcal-num(DAY.active))>0?'+':''}${Math.round(t.kcal-num(DAY.active))} kcal</b></div>
      <div class="tiny muted" style="margin-top:4px">※消費はApple Watchのアクティブカロリー(基礎代謝は含みません)</div>
    </div>` : ''}

    <h2 class="sec">今日のPFCバランス</h2>
    <div class="card">
      ${pfcRow('P たんぱく質', t.p, GOALS.protein, 'var(--rose)', 'over-good')}
      ${pfcRow('F 脂質', t.f, GOALS.fat, 'var(--amber)', 'over-bad')}
      ${pfcRow('C 炭水化物', t.c, GOALS.carb, 'var(--blue)', 'neutral')}
    </div>

    <h2 class="sec">クイック記録</h2>
    <div class="card">
      <div style="border-bottom:1px solid var(--line);margin-bottom:12px">
      ${SUPPLEMENTS.map(sp=>{
        const on=!!(DAY.supplements&&DAY.supplements[sp.id]);
        // 今日の20時以降で未摂取ならアンバー強調 (飲み忘れの受動リマインド)
        const warn=!on && curDate===todayStr() && new Date().getHours()>=20;
        return `<div class="item" role="button" tabindex="0" style="cursor:pointer"
          onclick="toggleSupp('${sp.id}')"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSupp('${sp.id}')}">
          <div class="ico">${sp.icon}</div>
          <div class="meta"><div class="nm">${esc(sp.name)}</div><div class="sb">${esc(sp.hint)}</div></div>
          <div class="chip ${on?'on':(warn?'warn':'')}">${on?'✓ 摂取済':(warn?'⚠ 未':'未')}</div>
        </div>`;
      }).join('')}
      </div>
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn primary grow" onclick="openMealSheet()">🍽 食事</button>
        <button class="btn amber grow" onclick="setTab('Workout')">💪 運動</button>
      </div>
      <div class="btn-row">
        <button class="btn grow" onclick="addWater(200)">💧 +200ml</button>
        <button class="btn grow" onclick="addWater(500)">💧 +500ml</button>
        <button class="btn grow" onclick="openBodySheet()">⚖️ 体重</button>
      </div>
      <button class="btn block" style="margin-top:10px" onclick="openCoachSheet()">🤖 今日のフィードバック${DAY.coach?' ✓':''}</button>
    </div>`;
}

/* ---------- AIコーチ (今日のFB) ---------- */
function openCoachSheet(){
  const cached = DAY.coach;
  sheet(`<h3>🤖 ${curDate===todayStr()?'今日':fmtDateLabel(curDate)}のフィードバック</h3>
    <div id="coachBody" style="white-space:pre-wrap;line-height:1.75;font-size:14px;min-height:90px;padding:4px 2px">${cached?esc(cached.text):''}</div>
    ${cached?`<div class="tiny muted" style="margin:6px 2px">生成: ${fmtDateTime(new Date(cached.ts))}</div>`:''}
    <div class="btn-row" style="margin-top:12px">
      <button id="coachGenBtn" class="btn primary grow" onclick="genCoach()">${cached?'🔄 再生成':'✨ 生成する'}</button>
      <button class="btn ghost grow" onclick="closeSheet()">閉じる</button>
    </div>`);
  if(!cached) genCoach();
}
async function genCoach(){
  const el=q('#coachBody'); if(!el) return;
  el.innerHTML='<div class="empty"><span class="ai-spin"></span> 直近1週間のデータを分析中…(10秒ほど)</div>';
  const btn=q('#coachGenBtn'); if(btn) btn.disabled=true;
  try{
    const r = await fetch(AI_WORKER_URL+'/coach', { method:'POST',
      headers:{'content-type':'application/json'}, body: JSON.stringify({ date: curDate }) });
    const d = await r.json();
    if(!r.ok || d.error) throw new Error(d.error || ('HTTP '+r.status));
    if(q('#coachBody')) q('#coachBody').textContent = d.feedback;
  }catch(e){
    if(q('#coachBody')) q('#coachBody').innerHTML = '<span style="color:var(--bad)">エラー: '+esc(String(e.message||e))+'</span>';
  }finally{ const b=q('#coachGenBtn'); if(b){ b.disabled=false; b.textContent='🔄 再生成'; } }
}
function fmtH(h){ const hh=Math.floor(h); const mm=Math.round((h-hh)*60); return mm>=60?(hh+1)+':00':hh+':'+String(mm).padStart(2,'0'); }
function fmtHM(h){ let total=Math.max(0,Math.round(h*60)); const hh=Math.floor(total/60), mm=total%60; return hh+'時間'+String(mm).padStart(2,'0')+'分'; }
function fmtDateTime(d){ if(!d) return '—'; const M=d.getMonth()+1, D=d.getDate(), w=['日','月','火','水','木','金','土'][d.getDay()];
  const hh=String(d.getHours()).padStart(2,'0'), mm=String(d.getMinutes()).padStart(2,'0');
  const ds=todayStr(d); const lbl = ds===todayStr()?'今日':(ds===shiftDate(todayStr(),1)?'明日':(ds===shiftDate(todayStr(),-1)?'昨日':`${M}/${D}(${w})`));
  return `${lbl} ${hh}:${mm}`; }
function tile(lab,val,goal,unit,color){
  const pct = goal? Math.min(100, (num(val)/goal)*100):0;
  const disp = typeof val==='number' ? val.toLocaleString() : val;  // 歩数等の5桁はカンマ区切り
  return `<div class="tile"><div class="lab"><span>${lab}</span><span class="goal">/ ${Number(goal).toLocaleString()}${unit}</span></div>
    <div class="val mono">${disp}<small> ${unit}</small></div>
    <div class="bar"><i style="width:${pct}%;background:${color}"></i></div></div>`;
}
// mode: 'over-bad'=超過を赤警告(脂質) / 'over-good'=目標到達を緑で称える(たんぱく質) / 'neutral'=超えても色を変えない(炭水化物)
function pfcRow(lab,val,goal,color,mode){
  mode = mode||'neutral';
  const pct = goal? Math.min(100,(num(val)/goal)*100):0;
  const bad  = mode==='over-bad'  && goal && num(val)>goal;
  const good = mode==='over-good' && goal && num(val)>=goal;
  const badge = bad ? ' <span style="color:var(--rose)">超過</span>'
              : good ? ' <span style="color:var(--green)">✓ 達成</span>' : '';
  return `<div style="padding:7px 0">
    <div class="row between" style="margin-bottom:5px">
      <span class="muted tiny">${lab}</span>
      <span class="mono tiny" style="font-weight:700;color:${good?'var(--green)':(bad?'var(--rose)':color)}">${d1(val)}<span class="muted" style="font-weight:600"> / ${goal||'—'} g</span>${badge}</span>
    </div>
    <div class="bar"><i style="width:${pct}%;background:${bad?'var(--rose)':(good?'var(--green)':color)}"></i></div>
  </div>`;
}

/* ---------- Meals view ---------- */
// 食事区分の定義 (順序=表示順)
const MEAL_TYPES=[
  {key:'breakfast', label:'朝食', icon:'🌅'},
  {key:'lunch',     label:'昼食', icon:'🍱'},
  {key:'dinner',    label:'夕食', icon:'🌙'},
  {key:'snack',     label:'間食', icon:'🍪'},
];
function mealTypeOf(m){ return MEAL_TYPES.find(t=>t.key===m.type) || {key:'other',label:'その他',icon:'🍽️'}; }

function renderMeals(){
  const el=q('#viewMeals'); const t=mealTotals();
  // 区分ごとにグループ化 (区分内は時刻順)
  const groups={};
  for(const k in DAY.meals){ const tp=mealTypeOf(DAY.meals[k]).key; (groups[tp]=groups[tp]||[]).push(k); }
  const order=[...MEAL_TYPES.map(t=>t.key),'other'];
  let groupHtml='';
  for(const gk of order){
    const ks=(groups[gk]||[]).sort((a,b)=>(DAY.meals[a].at||'').localeCompare(DAY.meals[b].at||''));
    if(!ks.length) continue;
    const tdef=MEAL_TYPES.find(t=>t.key===gk)||{label:'その他',icon:'🍽️'};
    let gk_=0,gp=0,gf=0,gc=0;
    ks.forEach(k=>{const m=DAY.meals[k];gk_+=num(m.kcal);gp+=num(m.p);gf+=num(m.f);gc+=num(m.c);});
    groupHtml+=`<div class="card">
      <div class="row between" style="margin-bottom:6px">
        <b>${tdef.icon} ${tdef.label}</b>
        <span class="tiny muted mono">${Math.round(gk_)}kcal ・ P${d1(gp)} F${d1(gf)} C${d1(gc)}</span>
      </div>
      ${ks.map(k=>{const m=DAY.meals[k];
        return `<div class="item" onclick="openMealEdit('${k}')" style="cursor:pointer">
          <div class="ico">${m.photo?'📷':'🍽️'}</div>
          <div class="meta"><div class="nm">${esc(m.name||'食事')}</div>
            <div class="sb">${esc(m.at||'')} ・ P${d1(m.p)} F${d1(m.f)} C${d1(m.c)}</div></div>
          <div class="amt">${Math.round(num(m.kcal))}<div class="tiny muted">kcal</div></div>
          <button class="del" onclick="event.stopPropagation();delMeal('${k}')">🗑</button>
        </div>`;}).join('')}
    </div>`;
  }
  el.innerHTML = `
    <div class="card">
      <div class="row between">
        <div><div class="tiny muted">合計</div><div class="big mono">${Math.round(t.kcal)}<small style="font-size:14px;color:var(--sub)"> kcal</small></div></div>
        <div class="tiny muted" style="text-align:right">
          P ${d1(t.p)}g ・ F ${d1(t.f)}g ・ C ${d1(t.c)}g<br>${t.n} 件
        </div>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary grow" onclick="openMealSheet()">🍽 食事を追加</button>
        <button class="btn grow" onclick="copyPrevDayMeals()">📋 前日コピー</button>
      </div>
    </div>
    ${groupHtml || '<div class="card"><div class="empty">まだ記録がありません</div></div>'}`;
}

/* ---------- Workout view ---------- */
function renderWorkout(){
  const el=q('#viewWorkout'); const done=DAY.workout.exercises;
  el.innerHTML = `
    <div class="card">
      <div class="row between"><b>💪 今日のトレーニング</b>
        <button class="btn sm" onclick="openExerciseEditor()">⚙️ 種目編集</button></div>
    </div>
    ${EXERCISES.map(ex=>{
      const v=done[ex.id];
      if(ex.type==='check'){
        const on=!!(v&&v.done);
        return `<div class="card tap" onclick="toggleCheck('${ex.id}')">
          <div class="row"><div class="ico" style="font-size:22px">${ex.icon||'✅'}</div>
            <div class="grow"><b>${esc(ex.name)}</b></div>
            <div class="chip ${on?'on':''}">${on?'✓ 完了':'未実施'}</div></div></div>`;
      } else {
        const n=v?num(v.count):0;
        const st=Math.max(1,num(ex.step)||1);  // ±ボタンの刻みは種目ごと (既定種目=5、追加種目=1、編集可)
        return `<div class="card">
          <div class="row between"><div class="row" style="gap:10px"><span style="font-size:22px">${ex.icon||'🏋️'}</span><b>${esc(ex.name)}</b></div>
            <div class="counter">
              <button class="${st>1?'stp':''}" onclick="bumpCount('${ex.id}',-${st})">${st>1?'−'+st:'−'}</button>
              <span class="n mono" id="cnt_${ex.id}">${n}</span>
              <button class="${st>1?'stp':''}" onclick="bumpCount('${ex.id}',${st})">${st>1?'+'+st:'＋'}</button>
            </div></div>
          <div class="row" style="gap:8px;margin-top:8px;justify-content:flex-end">
            ${(ex.quick||[1,10]).map(qn=>`<button class="btn sm" onclick="bumpCount('${ex.id}',${qn})">+${qn}</button>`).join('')}
            ${ex.unit?`<span class="tiny muted" style="align-self:center">${esc(ex.unit)}</span>`:''}
          </div></div>`;
      }
    }).join('')}
    <h2 class="sec">メモ</h2>
    <div class="card">
      <textarea id="woNote" placeholder="今日の運動メモ（ランニング、ジム等）" onblur="saveWoNote()" style="width:100%;min-height:60px;padding:12px;border-radius:12px;background:var(--bg2);border:1px solid var(--line);color:var(--ink)">${esc(DAY.workout.note||'')}</textarea>
    </div>`;
}

/* ---------- Body view ---------- */
function renderBody(){
  const el=q('#viewBody'); const b=DAY.body;
  el.innerHTML=`
    <h2 class="sec">からだの記録</h2>
    <div class="tiles">
      ${bodyTile('⚖️','体重', b.weight, 'kg','openBodySheet()')}
      ${bodyTile('📉','体脂肪率', b.fat, '%','openBodySheet()')}
      ${bodyTile('💪','筋肉量', b.muscle, 'kg','openBodySheet()')}
      ${bodyTile('💧','水分', DAY.water||0, 'ml','openWaterSheet()')}
      ${bodyTile('😴','睡眠', DAY.sleep, 'h','openSleepSheet()')}
    </div>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:10px">体組成計アプリからコピーした表を貼り付けると、体重・体脂肪率・筋肉量を日付ごとに一括登録できます。</div>
      <button class="btn block" onclick="openScaleImportSheet()">📥 体組成計データ取り込み</button>
    </div>
    <h2 class="sec">体調・気分</h2>
    <div class="card">
      <div class="chips">
        ${['😣 不調','😐 普通','😊 好調'].map((m,i)=>`<button class="chip ${DAY.mood===i?'on':''}" onclick="setMood(${i})">${m}</button>`).join('')}
      </div>
    </div>
    <h2 class="sec">歩数・睡眠</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:10px">歩数・体重はiPhoneショートカットで自動連携できます(アカウント画面の設定参照)。手入力も可。</div>
      <div class="btn-row">
        <button class="btn grow" onclick="openStepsSheet()">👣 歩数を入力</button>
        <button class="btn grow" onclick="openSleepSheet()">😴 睡眠を入力</button>
      </div>
    </div>`;
}
function bodyTile(ic,lab,val,unit,fn){
  return `<div class="tile tap" onclick="${fn}"><div class="lab">${ic} ${lab}</div>
    <div class="val mono">${val==null||val===''?'—':val}<small> ${unit}</small></div></div>`;
}

/* ---------- Stats view ---------- */
let _statsRange=7;  // 7 or 30
let _calMode='fast';       // 達成カレンダーの表示レイヤー: fast | supp
let _bodyMetric='weight';  // からだ推移の表示指標: weight | fat | muscle
let _keepScroll=null;      // 再描画時にスクロール位置を維持 (トグル操作で最上部に飛ぶのを防ぐ)
function setStatsRange(n){ _keepScroll=window.scrollY; _statsRange=n; renderStats(); }
function setCalMode(m){ _keepScroll=window.scrollY; _calMode=m; renderStats(); }
function setBodyMetric(m){ _keepScroll=window.scrollY; _bodyMetric=m; renderStats(); }
async function renderStats(){
  const el=q('#viewStats'); const N=_statsRange;
  // 初回のみプレースホルダ表示。トグル再描画時は旧内容を残す (ページが縮んでスクロールが最上部に飛ぶのを防ぐ)
  if(!el.firstChild) el.innerHTML=`<div class="empty">${N}日間のデータを集計中…</div>`;
  const days=[]; for(let i=N-1;i>=0;i--) days.push(shiftDate(todayStr(),-i));
  const snaps=await Promise.all(days.map(d=> uref('days/'+d).once('value').then(s=>s.val()||{}) ));
  const data=days.map((d,i)=>{
    const v=snaps[i]; let kcal=0,p=0;
    const meals=(v.meals)||{}; for(const k in meals){ kcal+=num(meals[k].kcal); p+=num(meals[k].p); }
    const ats=Object.values(meals).map(m=>m.at).filter(Boolean).sort();
    const fast = ats.length? (ats.length>=2? hhDiff(ats[0],ats[ats.length-1])<=(24-GOALS.fastHours)+0.5 : true) : null;
    return { date:d, kcal:Math.round(kcal), protein:Math.round(p), steps:v.steps||0,
      weight:(v.body&&v.body.weight)||null, fat:(v.body&&v.body.fat)||null,
      muscle:(v.body&&v.body.muscle)||null, fast,
      supp: v.supplements ? Object.values(v.supplements).filter(Boolean).length : 0 };
  });
  // fasting streak: 昨日から日付連続で遡る。
  // 今日は未確定日として扱う (達成済みなら加算、食事なし=歩数自動連携だけのノードでも streak を切らない)
  let streak=0; const allDays=await uref('days').once('value').then(s=>s.val()||{});
  const fastOk=ds=>{
    const meals=(allDays[ds]&&allDays[ds].meals)||{};
    const ats=Object.values(meals).map(m=>m.at).filter(Boolean).sort();
    if(!ats.length) return null;  // 食事記録なし
    const span = ats.length>=2 ? hhDiff(ats[0],ats[ats.length-1]) : 0;
    return span <= (24-GOALS.fastHours)+0.5;
  };
  const todayOk=fastOk(todayStr());
  if(todayOk!==false){
    if(todayOk===true) streak++;
    for(let ds=shiftDate(todayStr(),-1), i=0; i<3660; ds=shiftDate(ds,-1), i++){
      if(fastOk(ds)===true) streak++; else break;
    }
  }
  // サマリ集計
  const recK=data.filter(d=>d.kcal>0), recS=data.filter(d=>d.steps>0);
  const avgK=recK.length?Math.round(recK.reduce((a,d)=>a+d.kcal,0)/recK.length):0;
  const avgP=recK.length?Math.round(recK.reduce((a,d)=>a+d.protein,0)/recK.length):0;
  const avgS=recS.length?Math.round(recS.reduce((a,d)=>a+d.steps,0)/recS.length):0;
  const fastDays=data.filter(d=>d.fast===true).length, fastRec=data.filter(d=>d.fast!==null).length;
  const maxK=Math.max(GOALS.calorie,...data.map(d=>d.kcal),1);
  const maxS=Math.max(GOALS.steps,...data.map(d=>d.steps),1);
  const weights=data.filter(d=>d.weight!=null);
  const suppBoth=data.filter(d=>d.supp>=SUPPLEMENTS.length).length;
  const suppOne=data.filter(d=>d.supp>0&&d.supp<SUPPLEMENTS.length).length;
  // 前期間 (直前N日) の平均: allDays から算出して比較矢印に使う
  let pk=0,pkn=0,ppr=0,pst=0,psn=0;
  for(let i=2*N-1;i>=N;i--){
    const v=allDays[shiftDate(todayStr(),-i)]||{};
    let k=0,pr=0,n=0; for(const key in (v.meals||{})){ k+=num(v.meals[key].kcal); pr+=num(v.meals[key].p); n++; }
    if(n){ pk+=k; ppr+=pr; pkn++; }
    if(v.steps>0){ pst+=v.steps; psn++; }
  }
  const prevK=pkn?Math.round(pk/pkn):null, prevP=pkn?Math.round(ppr/pkn):null, prevS=psn?Math.round(pst/psn):null;
  const cmpLbl = N===7?'先週比':'前期間比';
  // 比較矢印: goodDown=true なら減少が良い(緑)。差1未満は表示しない
  const cmp=(cur,prev,goodDown)=>{
    if(prev==null||!cur) return '';
    const d=Math.round(cur-prev); if(Math.abs(d)<1) return '';
    const good = goodDown ? d<0 : d>0;
    return ` <span class="tiny" style="font-weight:700;color:${good?'var(--green)':'var(--rose)'}">${d>0?'▲':'▼'}${Math.abs(d).toLocaleString()}</span>`;
  };
  // 達成率バー付きサマリ行
  const statRow=(lab,valHtml,pct,color)=>`<div style="padding:7px 0">
    <div class="row between" style="margin-bottom:5px"><span class="muted tiny">${lab}</span><span class="mono tiny" style="font-weight:700">${valHtml}</span></div>
    <div class="bar"><i style="width:${Math.max(0,Math.min(100,pct))}%;background:${color}"></i></div></div>`;
  // 体重予測(G): 直近の傾きから目標体重到達まで
  let predHtml='';
  if(GOALS.targetWeight>0 && weights.length>=2){
    const first=weights[0], last=weights[weights.length-1];
    const dDays=(new Date(last.date)-new Date(first.date))/86400000;
    const slope=dDays>0?(num(last.weight)-num(first.weight))/dDays:0; // kg/日
    const remain=num(last.weight)-GOALS.targetWeight;
    let msg;
    if(Math.abs(remain)<0.1) msg='🎯 目標体重に到達しています!';
    else if(slope===0||((remain>0)!==(slope<0))) msg='現在のペースでは目標体重に近づいていません(直近トレンド '+(slope>0?'+':'')+ (slope*7).toFixed(2)+'kg/週)';
    else { const wk=Math.abs(remain/(slope*7)); msg=`このペース(${(slope*7).toFixed(2)}kg/週)なら目標 ${GOALS.targetWeight}kg まで 約${Math.ceil(wk)}週間`; }
    predHtml=`<div class="card" style="background:var(--card)"><div class="tiny muted">🔮 目標体重予測</div><div style="font-weight:700;margin-top:4px">${msg}</div></div>`;
  }
  el.innerHTML=`
    <div class="seg" style="margin-bottom:12px">
      <button class="${N===7?'on':''}" onclick="setStatsRange(7)">7日</button>
      <button class="${N===30?'on':''}" onclick="setStatsRange(30)">30日</button>
    </div>
    <h2 class="sec">${N}日サマリー <span class="muted" style="font-weight:400;text-transform:none">(矢印は${cmpLbl})</span></h2>
    <div class="card">
      <div class="row between" style="padding:2px 0 9px"><span class="muted tiny">🔥 ファスティング連続達成</span><b class="streak">${streak} 日</b></div>
      ${statRow('⏱ ファスティング達成', `${fastDays} / ${fastRec} 日`,
        fastRec?fastDays/fastRec*100:0, (fastRec&&fastDays/fastRec>=0.8)?'var(--green)':'var(--amber)')}
      ${statRow('🔥 平均カロリー', `${avgK} / ${GOALS.calorie} kcal${cmp(avgK,prevK,true)}`,
        avgK/GOALS.calorie*100, avgK<=GOALS.calorie?'var(--green)':'var(--rose)')}
      ${statRow('🥩 平均たんぱく質', `${avgP} / ${GOALS.protein} g${cmp(avgP,prevP,false)}`,
        avgP/GOALS.protein*100, avgP>=GOALS.protein?'var(--green)':(avgP>=GOALS.protein*0.8?'var(--amber)':'var(--rose)'))}
      ${statRow('👣 平均歩数', `${avgS.toLocaleString()} / ${GOALS.steps.toLocaleString()} 歩${cmp(avgS,prevS,false)}`,
        avgS/GOALS.steps*100, avgS>=GOALS.steps?'var(--green)':(avgS>=GOALS.steps*0.8?'var(--amber)':'var(--rose)'))}
      ${statRow('💊 サプリ (2種とも)', `${suppBoth} / ${N} 日${suppOne?` <span class="muted" style="font-weight:400">(1種のみ ${suppOne}日)</span>`:''}`,
        suppBoth/N*100, suppBoth/N>=0.8?'var(--green)':'var(--amber)')}
    </div>
    <h2 class="sec">達成カレンダー</h2>
    <div class="card">
      <div class="seg" style="margin-bottom:10px">
        <button class="${_calMode==='fast'?'on':''}" onclick="setCalMode('fast')">⏱ ファスティング</button>
        <button class="${_calMode==='supp'?'on':''}" onclick="setCalMode('supp')">💊 サプリ</button>
      </div>
      <div class="fcal">
        ${['月','火','水','木','金','土','日'].map(w=>`<div class="c h">${w}</div>`).join('')}
        ${'<div class="c" style="background:transparent"></div>'.repeat((new Date(data[0].date+'T12:00:00').getDay()+6)%7)}
        ${data.map(d=>{
          let cls='';
          if(_calMode==='fast'){ cls = d.fast===true?'ok':(d.fast===false?'ng':''); }
          else { cls = d.supp>=SUPPLEMENTS.length?'ok':(d.supp>0?'half':''); }
          return `<div class="c ${cls}">${+d.date.slice(8)}</div>`; }).join('')}
      </div>
      <div class="legend">${_calMode==='fast'
        ? `<span><i style="background:rgba(52,211,153,.6)"></i>${GOALS.fastHours}h達成</span><span><i style="background:rgba(251,113,133,.45)"></i>未達</span><span><i style="background:var(--bg2)"></i>記録なし</span>`
        : `<span><i style="background:rgba(52,211,153,.6)"></i>2種とも</span><span><i style="background:rgba(245,158,11,.55)"></i>1種のみ</span><span><i style="background:var(--bg2)"></i>なし</span>`}</div>
    </div>
    <h2 class="sec">からだ推移</h2>
    <div class="card">
      <div class="seg" style="margin-bottom:10px">
        <button class="${_bodyMetric==='weight'?'on':''}" onclick="setBodyMetric('weight')">体重</button>
        <button class="${_bodyMetric==='fat'?'on':''}" onclick="setBodyMetric('fat')">体脂肪率</button>
        <button class="${_bodyMetric==='muscle'?'on':''}" onclick="setBodyMetric('muscle')">筋肉量</button>
      </div>
      ${(()=>{
        const defs={ weight:{lab:'体重',unit:'kg',goodDown:true,goal:GOALS.targetWeight>0?GOALS.targetWeight:null},
                     fat:{lab:'体脂肪率',unit:'%',goodDown:true,goal:null},
                     muscle:{lab:'筋肉量',unit:'kg',goodDown:false,goal:null} };
        const md=defs[_bodyMetric];
        const pts=data.filter(d=>d[_bodyMetric]!=null).map(d=>({x:d.date,y:num(d[_bodyMetric])}));
        const latest=pts.length?pts[pts.length-1].y:null;
        const diff=pts.length>=2? +(pts[pts.length-1].y-pts[0].y).toFixed(1) : null;
        return `<div class="row between" style="margin-bottom:4px">
          <div><span class="tiny muted">${md.lab} 最新${md.goal?` (目標 ${md.goal}${md.unit})`:''}</span>
            <div class="big mono">${latest!=null?d1(latest):'—'}<small style="font-size:14px;color:var(--sub)"> ${md.unit}</small></div></div>
          ${diff!=null&&diff!==0?`<span style="font-weight:800;font-size:15px;color:${(md.goodDown?diff<0:diff>0)?'var(--green)':'var(--rose)'}">${diff>0?'▲':'▼'}${Math.abs(diff)}${md.unit}<span class="tiny muted" style="font-weight:400"> / ${N}日</span></span>`:''}
        </div>${lineChart(pts, md.goal, md.unit)}`;
      })()}
    </div>
    ${_bodyMetric==='weight'?predHtml:''}
    <h2 class="sec">カロリー (${N}日)</h2>
    <div class="card"><div class="chartbox${N>7?' dense':''}">
      <i class="goal-line" style="bottom:${Math.round(16+(GOALS.calorie/maxK)*100)}px"></i>
      ${data.map((d,i)=>{const h=Math.max(3,Math.round((d.kcal/maxK)*100));const over=d.kcal>GOALS.calorie;
        return `<div class="col"><div class="vlab">${N<=7&&d.kcal?d.kcal.toLocaleString():''}</div><div class="bb" style="height:${h}px;background:${d.kcal?(over?'linear-gradient(180deg,#fb7185,#e11d48)':'linear-gradient(180deg,#34d399,#059669)'):'var(--bg2)'}"></div><div class="lab">${(N<=7||i%5===0)?d.date.slice(8):''}</div></div>`}).join('')}
    </div><div class="legend"><span><i style="background:var(--green)"></i>目標内</span><span><i style="background:var(--rose)"></i>超過</span><span style="color:var(--amber)">- - 目標 ${GOALS.calorie.toLocaleString()}kcal</span></div></div>
    <h2 class="sec">歩数 (${N}日)</h2>
    <div class="card"><div class="chartbox${N>7?' dense':''}">
      <i class="goal-line" style="bottom:${Math.round(16+(GOALS.steps/maxS)*100)}px"></i>
      ${data.map((d,i)=>{const h=Math.max(3,Math.round((d.steps/maxS)*100));const ok=d.steps>=GOALS.steps;
        return `<div class="col"><div class="vlab">${N<=7&&d.steps?d.steps.toLocaleString():''}</div><div class="bb" style="height:${h}px;background:${d.steps?(ok?'linear-gradient(180deg,#34d399,#059669)':'linear-gradient(180deg,#60a5fa,#3b82f6)'):'var(--bg2)'}"></div><div class="lab">${(N<=7||i%5===0)?d.date.slice(8):''}</div></div>`}).join('')}
    </div><div class="legend"><span><i style="background:var(--green)"></i>目標達成</span><span><i style="background:var(--blue)"></i>未達</span><span style="color:var(--amber)">- - 目標 ${GOALS.steps.toLocaleString()}歩</span></div></div>
    <div style="height:8px"></div>
    <button class="btn ghost block" onclick="openGoalSheet()">⚙️ 目標値を設定</button>`;
  if(_keepScroll!=null){ window.scrollTo(0,_keepScroll); _keepScroll=null; }  // トグル操作時のスクロール位置復元
}
function hhDiff(a,b){ const pa=a.split(':'),pb=b.split(':'); return (pb[0]*60+ +pb[1]-(pa[0]*60+ +pa[1]))/60; }
// SVG折れ線グラフ (points=[{x:label,y:val}], goalLine=目標値 or null)
function lineChart(points, goalLine, unit){
  if(!points.length) return '<div class="empty">記録すると推移グラフが出ます</div>';
  if(points.length===1){ const p=points[0]; return `<div class="row between" style="padding:6px 0"><span class="tiny muted">${p.x}</span><span class="mono" style="font-weight:700">${p.y} ${unit}</span></div><div class="tiny muted">2回以上記録するとグラフになります</div>`; }
  const W=320,H=120,pad=8;
  const ys=points.map(p=>p.y).concat(goalLine!=null?[goalLine]:[]);
  let mn=Math.min(...ys), mx=Math.max(...ys); if(mn===mx){mn-=1;mx+=1;} const span=mx-mn;
  const xstep=(W-pad*2)/(points.length-1);
  const X=i=>pad+i*xstep, Y=v=>pad+(H-pad*2)*(1-(v-mn)/span);
  const path=points.map((p,i)=>`${i?'L':'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const dots=points.map((p,i)=>`<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="var(--teal)"/>`).join('');
  const goal=goalLine!=null?`<line x1="${pad}" y1="${Y(goalLine).toFixed(1)}" x2="${W-pad}" y2="${Y(goalLine).toFixed(1)}" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="5 4"/>`:'';
  const first=points[0], last=points[points.length-1]; const diff=(last.y-first.y);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:130px">
    ${goal}
    <path d="${path}" fill="none" stroke="var(--teal)" stroke-width="2"/>
    ${dots}
  </svg>
  <div class="row between" style="margin-top:6px"><span class="tiny muted">${first.x} ${first.y}${unit}</span>
    <span class="tiny" style="font-weight:700;color:${diff<=0?'var(--green)':'var(--rose)'}">${diff>0?'+':''}${diff.toFixed(1)}${unit}</span>
    <span class="tiny muted">${last.x} ${last.y}${unit}</span></div>`;
}

/* ===================== WRITES ===================== */
function delMeal(k){ if(confirm('この食事を削除しますか?')){
  const upd={}; upd['meals/'+k]=null;
  if(k.indexOf('supp_')===0) upd['supplements/'+k.slice(5)]=null;  // サプリ項目はチェックも連動解除
  uref('days/'+curDate).update(upd).then(()=>toast('削除しました')); } }
function addWater(ml){ const v=(DAY.water||0)+ml; uref('days/'+curDate+'/water').set(v).then(()=>toast('💧 +'+ml+'ml')); }
function setMood(i){ uref('days/'+curDate+'/mood').set(i); }
function toggleCheck(id){ const cur=DAY.workout.exercises[id]; const nv=!(cur&&cur.done);
  DAY.workout.exercises[id]={done:nv}; render();  // 楽観更新: 書込を待たず即時反映
  uref('days/'+curDate+'/workout/exercises/'+id).set({done:nv}).then(()=>nv&&toast('✅ 完了!')); }
function toggleSupp(id){ const nv=!(DAY.supplements&&DAY.supplements[id]);
  const sp=SUPPLEMENTS.find(s=>s.id===id);
  // 食事欄にもサプリ項目を連動追加/削除 (固定キー supp_{id}、at無し=ファスティング計算に影響しない)
  const meal = sp? { name:'💊 '+sp.name+' ('+sp.dose+')', kcal:sp.kcal, p:sp.p, f:sp.f, c:sp.c, type:sp.mealType, ts:Date.now() } : null;
  DAY.supplements=DAY.supplements||{}; DAY.supplements[id]=nv;             // 楽観更新
  if(meal){ if(nv) DAY.meals['supp_'+id]=meal; else delete DAY.meals['supp_'+id]; }
  render();
  const upd={}; upd['supplements/'+id]=nv||null;
  if(meal) upd['meals/supp_'+id]= nv? meal : null;
  uref('days/'+curDate).update(upd).then(()=>{ if(nv) toast('💊 記録しました'); }); }
function bumpCount(id,delta){
  const cur=DAY.workout.exercises[id]; const n=Math.max(0,(cur?num(cur.count):0)+delta);
  DAY.workout.exercises[id]={count:n};                        // 楽観更新
  const s=q('#cnt_'+id); if(s) s.textContent=n;               // 全再描画せず数字だけ即書き換え
  uref('days/'+curDate+'/workout/exercises/'+id+'/count')
    .transaction(c=>Math.max(0, num(c)+delta));               // 連打でも加算を取りこぼさない
}
function saveWoNote(){ const v=q('#woNote').value; uref('days/'+curDate+'/workout/note').set(v); }

/* ===================== SHEETS (modals) ===================== */
function closeSheet(){ q('#modalRoot').innerHTML=''; }
function sheet(html){
  q('#modalRoot').innerHTML=`<div class="scrim" onclick="if(event.target===this)closeSheet()">
    <div class="sheet"><div class="grip"></div>${html}</div></div>`;
}
// シート表示中は背景(body)スクロールをロック。#modalRoot の増減を MutationObserver で自動追跡
let _lockY=0;
function _syncBodyLock(){
  const open=!!q('#modalRoot').firstChild, b=document.body;
  if(open && b.style.position!=='fixed'){
    _lockY=window.scrollY||0;
    b.style.position='fixed'; b.style.top=(-_lockY)+'px'; b.style.left='0'; b.style.right='0'; b.style.width='100%';
  } else if(!open && b.style.position==='fixed'){
    b.style.position=''; b.style.top=''; b.style.left=''; b.style.right=''; b.style.width='';
    window.scrollTo(0,_lockY);
  }
}

function foodMasterList(){
  // ピン留め(pin)を最優先 → 使用回数 → 新しい順
  return Object.entries(FOOD_MASTER).map(([id,f])=>({id,...f}))
    .sort((a,b)=>(b.pin?1:0)-(a.pin?1:0) || (b.uses||0)-(a.uses||0) || (b.ts||0)-(a.ts||0));
}
function togglePinFood(id){
  const f=FOOD_MASTER[id]; if(!f) return;
  const nv=!f.pin; f.pin=nv;
  uref('settings/foodMaster/'+id+'/pin').set(nv).then(()=>{ renderFoodChips(q('#foodSearch')?q('#foodSearch').value:''); toast(nv?'⭐ ピン留め':'ピン解除'); });
}
// 区分の既定値: 時刻から推定
function guessMealType(){ const h=new Date().getHours(); if(h<10)return'breakfast'; if(h<15)return'lunch'; if(h<21)return'dinner'; return'snack'; }
let _mealCart=[];  // まとめ登録用カート [{name,kcal,p,f,c}]

function openMealSheet(){
  _mealCart=[];
  const fav=foodMasterList();
  const favHtml = fav.length ? `
    <div class="field">
      <label>マイ食品から選ぶ <span class="muted">(${fav.length}件・タップで即追加)</span></label>
      <input id="foodSearch" placeholder="🔍 名前で絞り込み" oninput="renderFoodChips(this.value)" style="margin-bottom:8px">
      <div id="foodChips" class="food-chips"></div>
    </div>` : '';
  sheet(`<h3>🍽 食事を記録</h3>
    <div class="field"><label>区分</label>
      <div class="seg" id="mealTypeSeg">
        ${MEAL_TYPES.map(t=>`<button data-mt="${t.key}" onclick="pickMealType('${t.key}')">${t.icon}${t.label}</button>`).join('')}
      </div>
    </div>
    <div class="field"><label>時刻 (この回の食事)</label><input id="mAt" type="time" value="${nowHHMM()}"></div>
    <div class="or-sep"><span>品目を追加(複数まとめOK)</span></div>
    ${favHtml}
    <div id="cartBox"></div>
    <div class="or-sep"><span>または手入力 / 写真</span></div>
    <div class="ai-drop" style="margin-bottom:14px">
      <img id="aiPrev" class="ai-preview hidden">
      <div id="aiStatus" class="tiny muted" style="margin-bottom:10px">📷 写真からカロリー・PFCをAI推定できます</div>
      <input id="aiCam" type="file" accept="image/*" capture="environment" class="hidden" onchange="onPhotoPicked(event)">
      <input id="aiLib" type="file" accept="image/*" class="hidden" onchange="onPhotoPicked(event)">
      <div class="btn-row" style="justify-content:center">
        <button class="btn primary sm" onclick="document.getElementById('aiCam').click()">📷 撮影</button>
        <button class="btn sm" onclick="document.getElementById('aiLib').click()">🖼 写真を選択</button>
        <button id="aiHiBtn" class="btn sm hidden" onclick="reEstimate(true)">🔍 高精度</button>
      </div>
    </div>
    <div class="field"><label>料理名</label><input id="mName" placeholder="例: 鶏むね定食"></div>
    <div class="two">
      <div class="field"><label>カロリー (kcal)</label><input id="mKcal" type="number" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>たんぱく質 (g)</label><input id="mP" type="number" inputmode="decimal" step="0.1" placeholder="0.0"></div>
    </div>
    <div class="two">
      <div class="field"><label>脂質 (g)</label><input id="mF" type="number" inputmode="decimal" step="0.1" placeholder="0.0"></div>
      <div class="field"><label>炭水化物 (g)</label><input id="mC" type="number" inputmode="decimal" step="0.1" placeholder="0.0"></div>
    </div>
    <button class="btn block" style="margin-bottom:10px" onclick="addToCart()">＋ この品をリストに追加</button>
    <button class="btn primary block" onclick="saveMeal()">保存</button>`);
  pickMealType(guessMealType());
  renderCart();
  if(foodMasterList().length) renderFoodChips('');
}
let _mealType='lunch';
function pickMealType(k){ _mealType=k; const seg=q('#mealTypeSeg'); if(seg) seg.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.mt===k)); }
function curMealItem(){ return { name:q('#mName').value.trim(), kcal:num(q('#mKcal').value), p:num(q('#mP').value), f:num(q('#mF').value), c:num(q('#mC').value) }; }
function clearMealInputs(){ ['mName','mKcal','mP','mF','mC'].forEach(id=>{const e=q('#'+id); if(e)e.value='';}); const st=q('#aiStatus'); if(st)st.textContent='📷 写真からカロリー・PFCをAI推定できます'; const pv=q('#aiPrev'); if(pv)pv.classList.add('hidden'); _lastPhotoData=null; }
function addToCart(){
  const it=curMealItem();
  if(!it.name && !it.kcal){ toast('料理名かカロリーを入力してください'); return; }
  it.name=it.name||'食事'; if(_lastPhotoData) it.photo=true;
  _mealCart.push(it); clearMealInputs(); renderCart();
  toast('「'+it.name+'」を追加');
}
function renderCart(){
  const box=q('#cartBox'); if(!box) return;
  if(!_mealCart.length){ box.innerHTML=''; return; }
  const tk=_mealCart.reduce((a,x)=>a+num(x.kcal),0);
  box.innerHTML=`<div class="card" style="background:var(--card);margin-bottom:10px">
    <div class="tiny muted" style="margin-bottom:4px">追加リスト(${_mealCart.length}品・計${Math.round(tk)}kcal) — 保存で全部登録</div>
    ${_mealCart.map((x,i)=>`<div class="row between" style="padding:4px 0"><span class="tiny">${esc(x.name)}</span><span class="tiny muted">${Math.round(num(x.kcal))}kcal <span onclick="rmCart(${i})" style="color:var(--bad);margin-left:6px;cursor:pointer">×</span></span></div>`).join('')}
  </div>`;
}
function rmCart(i){ _mealCart.splice(i,1); renderCart(); }
function renderFoodChips(filter){
  const box=q('#foodChips'); if(!box) return;
  const f=(filter||'').trim();
  let list=foodMasterList();
  if(f) list=list.filter(x=>x.name.includes(f));
  list=list.slice(0,30);
  box.innerHTML = list.length ? list.map(x=>
    `<button class="food-chip" onclick='pickFood("${x.id}")'>
       <span class="fc-pin" onclick='event.stopPropagation();togglePinFood("${x.id}")' style="color:${x.pin?'var(--amber)':'var(--line)'}">${x.pin?'⭐':'☆'}</span>
       <span class="fc-name">${esc(x.name)}</span>
       <span class="fc-kcal">${Math.round(num(x.kcal))}kcal</span>
       <span class="fc-del" onclick='event.stopPropagation();delFood("${x.id}")'>×</span>
     </button>`).join('') : '<div class="tiny muted" style="padding:4px">該当なし</div>';
}
function pickFood(id){
  const f=FOOD_MASTER[id]; if(!f) return;
  // タップで即カートに追加 (フォーム往復・スクロール不要、キーボードも出さない)
  _mealCart.push({ name:f.name||'食事', kcal:num(f.kcal), p:num(f.p), f:num(f.f), c:num(f.c) });
  renderCart();
  toast('「'+(f.name||'')+'」を追加');
}
function delFood(id){
  const f=FOOD_MASTER[id]; if(!f) return;
  if(!confirm('マイ食品「'+(f.name||'')+'」を削除しますか?(記録済みの食事は残ります)')) return;
  uref('settings/foodMaster/'+id).remove().then(()=>{ delete FOOD_MASTER[id]; renderFoodChips(q('#foodSearch')?q('#foodSearch').value:''); toast('削除しました'); });
}

let _lastPhotoData=null;
function onPhotoPicked(ev){
  const file=ev.target.files&&ev.target.files[0]; if(!file) return;
  // リサイズ(長辺1024)してbase64化 → 通信量とコスト削減
  const img=new Image(); const rd=new FileReader();
  rd.onload=()=>{ img.onload=()=>{
    const max=1024; let{width:w,height:h}=img; const sc=Math.min(1,max/Math.max(w,h));
    w=Math.round(w*sc); h=Math.round(h*sc);
    const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
    cv.getContext('2d').drawImage(img,0,0,w,h);
    _lastPhotoData=cv.toDataURL('image/jpeg',0.82);
    const pv=q('#aiPrev'); pv.src=_lastPhotoData; pv.classList.remove('hidden');
    reEstimate(false);
  }; img.src=rd.result; };
  rd.readAsDataURL(file);
}
async function reEstimate(hi){
  if(!_lastPhotoData) return;
  const st=q('#aiStatus'); st.innerHTML='<span class="ai-spin"></span> '+(hi?'高精度で解析中…':'AI解析中…');
  try{
    const r=await fetch(AI_WORKER_URL+'/estimate'+(hi?'?hi=1':''),{
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({ image:_lastPhotoData, note:q('#mName').value.trim() })
    });
    const d=await r.json();
    if(d.error){ st.textContent='⚠️ 解析失敗: '+d.error; return; }
    q('#mName').value=d.name||q('#mName').value;
    q('#mKcal').value=d.kcal||''; q('#mP').value=d.p||''; q('#mF').value=d.f||''; q('#mC').value=d.c||'';
    const conf={high:'高',medium:'中',low:'低'}[d.confidence]||'';
    st.innerHTML=`✅ 推定完了 (${d.model==='sonnet'?'高精度':'標準'}・確度${conf}) 必要なら数値を修正してください`;
    q('#aiHiBtn').classList.remove('hidden');
  }catch(e){ st.textContent='⚠️ 通信エラー: '+(e.message||e); }
}
function saveMeal(){
  const at=q('#mAt').value||nowHHMM();
  const items=[..._mealCart];
  // 入力欄に残っている品も対象に
  const cur=curMealItem();
  if(cur.name || cur.kcal){ cur.name=cur.name||'食事'; if(_lastPhotoData) cur.photo=true; items.push(cur); }
  if(!items.length){ toast('品目がありません'); return; }
  const updates={};
  items.forEach(it=>{
    const m={ name:it.name, at, type:_mealType, kcal:num(it.kcal), p:num(it.p), f:num(it.f), c:num(it.c), ts:Date.now() };
    if(it.photo) m.photo=true;
    updates['days/'+curDate+'/meals/'+uuid()]=m;
    upsertFoodMaster(m);
  });
  uref('').update(updates).then(()=>{ closeSheet(); toast('🍽 '+items.length+'品 記録しました'); });
}
// ---- 食事編集(全項目修正可) ----
function openMealEdit(k){
  const m=DAY.meals[k]; if(!m) return;
  _mealType=m.type||guessMealType();
  sheet(`<h3>🍽 食事を編集</h3>
    <div class="field"><label>区分</label>
      <div class="seg" id="mealTypeSeg">
        ${MEAL_TYPES.map(t=>`<button data-mt="${t.key}" onclick="pickMealType('${t.key}')">${t.icon}${t.label}</button>`).join('')}
      </div>
    </div>
    <div class="field"><label>時刻</label><input id="eAt" type="time" value="${esc(m.at||nowHHMM())}"></div>
    <div class="field"><label>料理名</label><input id="eName" value="${esc(m.name||'')}"></div>
    <div class="two">
      <div class="field"><label>カロリー (kcal)</label><input id="eKcal" type="number" inputmode="numeric" value="${num(m.kcal)||''}"></div>
      <div class="field"><label>たんぱく質 (g)</label><input id="eP" type="number" inputmode="decimal" step="0.1" value="${num(m.p)||''}"></div>
    </div>
    <div class="two">
      <div class="field"><label>脂質 (g)</label><input id="eF" type="number" inputmode="decimal" step="0.1" value="${num(m.f)||''}"></div>
      <div class="field"><label>炭水化物 (g)</label><input id="eC" type="number" inputmode="decimal" step="0.1" value="${num(m.c)||''}"></div>
    </div>
    <button class="btn primary block" style="margin-bottom:8px" onclick="saveMealEdit('${k}')">更新</button>
    <button class="btn ghost block" onclick="delMeal('${k}');closeSheet()">🗑 この食事を削除</button>`);
  pickMealType(_mealType);
}
function saveMealEdit(k){
  const upd={ name:q('#eName').value.trim()||'食事', at:q('#eAt').value||nowHHMM(), type:_mealType,
    kcal:num(q('#eKcal').value), p:num(q('#eP').value), f:num(q('#eF').value), c:num(q('#eC').value) };
  uref('days/'+curDate+'/meals/'+k).update(upd).then(()=>{ closeSheet(); toast('✏️ 更新しました'); });
}
// ---- 前日の食事をコピー ----
async function copyPrevDayMeals(){
  const prev=shiftDate(curDate,-1);
  const snap=(await uref('days/'+prev+'/meals').once('value')).val()||{};
  const ks=Object.keys(snap).filter(k=>k.indexOf('supp_')!==0);  // サプリ項目はコピー対象外 (チェックと連動するため)
  if(!ks.length){ toast('前日('+fmtDateLabel(prev)+')の食事記録がありません'); return; }
  if(!confirm(fmtDateLabel(prev)+'の食事 '+ks.length+'品を今日にコピーしますか?')) return;
  const updates={};
  ks.forEach(k=>{ const m={...snap[k], ts:Date.now()}; updates['days/'+curDate+'/meals/'+uuid()]=m; });
  uref('').update(updates).then(()=>toast('📋 '+ks.length+'品コピーしました'));
}
// 同名(完全一致)があれば栄養値を更新+uses++、なければ新規。マスタは名前で一意化
function upsertFoodMaster(m){
  if(!m.name || m.name==='食事') return;
  const existing=Object.entries(FOOD_MASTER).find(([id,f])=>f.name===m.name);
  if(existing){
    const [id,f]=existing;
    uref('settings/foodMaster/'+id).update({ kcal:m.kcal, p:m.p, f:m.f, c:m.c, uses:(num(f.uses)||0)+1, ts:Date.now() });
  } else {
    const id=uuid();
    uref('settings/foodMaster/'+id).set({ name:m.name, kcal:m.kcal, p:m.p, f:m.f, c:m.c, uses:1, ts:Date.now() });
  }
}

function openBodySheet(){
  const b=DAY.body;
  sheet(`<h3>⚖️ からだの記録</h3>
    <div class="two">
      <div class="field"><label>体重 (kg)</label><input id="bW" type="number" inputmode="decimal" value="${b.weight||''}" placeholder="0.0"></div>
      <div class="field"><label>体脂肪率 (%)</label><input id="bF" type="number" inputmode="decimal" value="${b.fat||''}" placeholder="0.0"></div>
    </div>
    <div class="field"><label>筋肉量 (kg・任意)</label><input id="bM" type="number" inputmode="decimal" value="${b.muscle||''}" placeholder="0.0"></div>
    <button class="btn primary block" onclick="saveBody()">保存</button>`);
  setTimeout(()=>q('#bW')&&q('#bW').focus(),200);
}
function saveBody(){
  const upd={}; const w=q('#bW').value, f=q('#bF').value, mus=q('#bM').value;
  if(w!=='') upd.weight=num(w); if(f!=='') upd.fat=num(f); if(mus!=='') upd.muscle=num(mus);
  uref('days/'+curDate+'/body').update(upd).then(()=>{ closeSheet(); toast('⚖️ 記録しました'); });
}

/* ---------- 体組成計データ 貼り付けインポート ---------- */
function openScaleImportSheet(){
  sheet(`<h3>📥 体組成計データ取り込み</h3>
    <div class="field"><label>体組成計アプリからコピーした表を貼り付け</label>
      <textarea id="scaleData" placeholder="12:52 2026/07/05,65.10kg,22.3,14.2%,…&#10;(ヘッダ行が混ざっていてもOK)"
        style="width:100%;min-height:150px;padding:12px;border-radius:12px;background:var(--bg2);border:1px solid var(--line);color:var(--ink)"></textarea></div>
    <div class="tiny muted" style="margin-bottom:12px">体重・体脂肪率・筋肉量を日付ごとに登録します。同じ日に複数回の測定がある場合は最新時刻を採用。既存の記録と異なる値は体組成計の値で上書きします。</div>
    <button class="btn primary block" onclick="importScaleData()">取り込む</button>`);
  setTimeout(()=>q('#scaleData')&&q('#scaleData').focus(),200);
}
function parseScaleData(text){
  const lines = text.split(/\r?\n/);
  // ヘッダ行があれば列位置を特定 (無ければ既定: 体重1 / 体脂肪率3 / 筋肉量10 = オムロン形式)
  const idx = { weight:1, fat:3, muscle:10 };
  const header = lines.find(l=>l.includes('体重'));
  if(header){ const h=header.split(','); const fi=n=>h.findIndex(c=>c.trim()===n);
    if(fi('体重')>=0) idx.weight=fi('体重'); if(fi('体脂肪率')>=0) idx.fat=fi('体脂肪率'); if(fi('筋肉量')>=0) idx.muscle=fi('筋肉量'); }
  const out={};  // date -> {weight,fat,muscle,time}
  for(const raw of lines){
    const cells = raw.trim().split(',');
    const m = (cells[0]||'').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if(!m) continue;  // ヘッダ・空行・日付なし行はスキップ
    const date = m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
    const time = ((cells[0]||'').match(/\d{1,2}:\d{2}/)||['00:00'])[0].padStart(5,'0');
    const numAt = i=>{ const v=parseFloat(String(cells[i]||'').replace(/[^\d.\-]/g,'')); return isNaN(v)?null:v; };
    const rec = { weight:numAt(idx.weight), fat:numAt(idx.fat), muscle:numAt(idx.muscle), time };
    if(rec.weight==null && rec.fat==null && rec.muscle==null) continue;
    if(!out[date] || time > out[date].time) out[date]=rec;
  }
  return out;
}
async function importScaleData(){
  const recs = parseScaleData(q('#scaleData').value);
  const dates = Object.keys(recs).sort();
  if(!dates.length){ toast('⚠️ 取り込める行が見つかりませんでした'); return; }
  const lbl = d=>d.slice(5).replace('-','/');
  if(!confirm(dates.length+'日分 ('+lbl(dates[0])+'〜'+lbl(dates[dates.length-1])+') を登録します。既存と異なる値は体組成計の値で上書きします。よろしいですか?')) return;
  const updates={};
  for(const d of dates){ const r=recs[d];
    if(r.weight!=null) updates['days/'+d+'/body/weight']=r.weight;
    if(r.fat!=null)    updates['days/'+d+'/body/fat']=r.fat;
    if(r.muscle!=null) updates['days/'+d+'/body/muscle']=r.muscle;
  }
  await uref('').update(updates);
  closeSheet(); toast('📥 '+dates.length+'日分を取り込みました');
}
function openWaterSheet(){
  sheet(`<h3>💧 水分</h3>
    <div class="field"><label>現在の合計 (ml)</label><input id="wV" type="number" inputmode="numeric" value="${DAY.water||0}"></div>
    <div class="chips" style="margin-bottom:14px">
      ${[200,350,500].map(v=>`<button class="chip" onclick="document.getElementById('wV').value=(+document.getElementById('wV').value||0)+${v}">+${v}</button>`).join('')}
    </div>
    <button class="btn primary block" onclick="saveWater()">保存</button>`);
}
function saveWater(){ uref('days/'+curDate+'/water').set(num(q('#wV').value)).then(()=>{ closeSheet(); toast('💧 記録しました'); }); }
function openStepsSheet(){
  sheet(`<h3>👣 歩数</h3><div class="field"><label>歩数</label><input id="sV" type="number" inputmode="numeric" value="${DAY.steps||''}" placeholder="0"></div>
    <button class="btn primary block" onclick="saveSteps()">保存</button>`);
  setTimeout(()=>q('#sV')&&q('#sV').focus(),200);
}
function saveSteps(){ uref('days/'+curDate+'/steps').set(num(q('#sV').value)).then(()=>{ closeSheet(); toast('👣 記録しました'); }); }
function openSleepSheet(){
  sheet(`<h3>😴 睡眠</h3><div class="field"><label>睡眠時間 (h)</label><input id="slV" type="number" inputmode="decimal" value="${DAY.sleep||''}" placeholder="7.0"></div>
    <button class="btn primary block" onclick="saveSleep()">保存</button>`);
  setTimeout(()=>q('#slV')&&q('#slV').focus(),200);
}
function saveSleep(){ uref('days/'+curDate+'/sleep').set(num(q('#slV').value)).then(()=>{ closeSheet(); toast('😴 記録しました'); }); }

/* ---------- 目標設定 ---------- */
function openGoalSheet(){
  sheet(`<h3>⚙️ 目標値の設定</h3>
    <div class="two">
      <div class="field"><label>絶食目標 (h)</label><input id="gFast" type="number" inputmode="decimal" value="${GOALS.fastHours}"></div>
      <div class="field"><label>カロリー (kcal)</label><input id="gCal" type="number" inputmode="numeric" value="${GOALS.calorie}"></div>
    </div>
    <div class="three">
      <div class="field"><label>P たんぱく質(g)</label><input id="gPro" type="number" inputmode="numeric" value="${GOALS.protein}"></div>
      <div class="field"><label>F 脂質(g)</label><input id="gFat" type="number" inputmode="numeric" value="${GOALS.fat}"></div>
      <div class="field"><label>C 炭水化物(g)</label><input id="gCarb" type="number" inputmode="numeric" value="${GOALS.carb}"></div>
    </div>
    <div class="field"><label>水分 (ml)</label><input id="gWat" type="number" inputmode="numeric" value="${GOALS.water}"></div>
    <div class="two">
      <div class="field"><label>歩数</label><input id="gStep" type="number" inputmode="numeric" value="${GOALS.steps}"></div>
      <div class="field"><label>目標体重 (kg・任意)</label><input id="gTW" type="number" inputmode="decimal" step="0.1" value="${GOALS.targetWeight||''}" placeholder="未設定"></div>
    </div>
    <button class="btn primary block" onclick="saveGoals()">保存</button>`);
}
function saveGoals(){
  GOALS={ fastHours:num(q('#gFast').value)||16, calorie:num(q('#gCal').value)||2000,
    protein:num(q('#gPro').value)||120, fat:num(q('#gFat').value)||60, carb:num(q('#gCarb').value)||250,
    water:num(q('#gWat').value)||2000, steps:num(q('#gStep').value)||12000,
    targetWeight:num(q('#gTW').value)||0 };
  uref('settings/goals').set(GOALS).then(()=>{ closeSheet(); toast('⚙️ 目標を更新'); render(); });
}

/* ---------- 種目エディタ ---------- */
function openExerciseEditor(){
  sheet(`<h3>⚙️ 筋トレ種目の編集</h3>
    <div class="tiny muted" style="margin-bottom:8px">種目をタップすると名前・単位・±の増減量・クイックボタンを編集できます</div>
    <div id="exList">${EXERCISES.map((ex,i)=>exEditRow(ex,i)).join('')}</div>
    <h2 class="sec">新しい種目を追加</h2>
    <div class="field"><label>種目名</label><input id="exNewName" placeholder="例: プランク"></div>
    <div class="field"><label>記録タイプ</label>
      <div class="seg"><button id="exTypeCount" class="on" onclick="pickExType('count')">回数で記録</button>
        <button id="exTypeCheck" onclick="pickExType('check')">やった/やってない</button></div></div>
    <div class="two" id="exUnitWrap">
      <div class="field"><label>単位</label><input id="exNewUnit" value="回" placeholder="回 / 秒 / 分"></div>
      <div class="field"><label>±ボタンの増減量</label><input id="exNewStep" type="number" inputmode="numeric" value="1" min="1"></div>
    </div>
    <button class="btn primary block" onclick="addExercise()">＋ 種目を追加</button>
    <button class="btn ghost block" style="margin-top:8px" onclick="closeSheet()">閉じる</button>`);
}
let _newExType='count';
function pickExType(t){ _newExType=t; q('#exTypeCount').classList.toggle('on',t==='count'); q('#exTypeCheck').classList.toggle('on',t==='check'); q('#exUnitWrap').style.display=t==='count'?'grid':'none'; }
function exEditRow(ex,i){
  const sb = ex.type==='check' ? 'チェック式'
    : `回数式 (${esc(ex.unit||'回')}・±${Math.max(1,num(ex.step)||1)})${ex.quick?' ・ +'+ex.quick.join('/+'):''}`;
  return `<div class="item" onclick="openExerciseEdit(${i})" style="cursor:pointer"><div class="ico">${ex.icon||'🏋️'}</div>
    <div class="meta"><div class="nm">${esc(ex.name)}</div><div class="sb">${sb}</div></div>
    <button class="del" onclick="event.stopPropagation();delExercise(${i})">🗑</button></div>`;
}
function addExercise(){
  const name=q('#exNewName').value.trim(); if(!name){ toast('種目名を入力してください'); return; }
  const ex={ id:uuid(), name, type:_newExType, icon:'🏋️' };
  if(_newExType==='count'){ ex.unit=q('#exNewUnit').value.trim()||'回'; ex.step=Math.max(1,Math.round(num(q('#exNewStep').value))||1); }
  EXERCISES.push(ex); uref('settings/exercises').set(EXERCISES).then(()=>{ toast('種目を追加'); openExerciseEditor(); });
}
// ---- 既存種目の編集 (名前/単位/±刻み/クイックボタン) ----
function openExerciseEdit(i){
  const ex=EXERCISES[i]; if(!ex) return;
  sheet(`<h3>⚙️ 種目を編集</h3>
    <div class="field"><label>種目名</label><input id="exEName" value="${esc(ex.name)}"></div>
    ${ex.type==='count'?`
    <div class="two">
      <div class="field"><label>単位</label><input id="exEUnit" value="${esc(ex.unit||'回')}" placeholder="回 / 秒 / 分"></div>
      <div class="field"><label>±ボタンの増減量</label><input id="exEStep" type="number" inputmode="numeric" value="${Math.max(1,num(ex.step)||1)}" min="1"></div>
    </div>
    <div class="field"><label>クイック追加ボタン (カンマ区切り・最大4つ)</label><input id="exEQuick" value="${(ex.quick||[]).join(',')}" placeholder="例: 1,10,20"></div>`:''}
    <button class="btn primary block" onclick="saveExerciseEdit(${i})">保存</button>
    <button class="btn ghost block" style="margin-top:8px" onclick="openExerciseEditor()">← 種目一覧に戻る</button>`);
}
function saveExerciseEdit(i){
  const ex=EXERCISES[i]; if(!ex) return;
  const name=q('#exEName').value.trim(); if(!name){ toast('種目名を入力してください'); return; }
  ex.name=name;
  if(ex.type==='count'){
    ex.unit=q('#exEUnit').value.trim()||'回';
    ex.step=Math.max(1,Math.round(num(q('#exEStep').value))||1);
    const qs=q('#exEQuick').value.split(/[,、\s]+/).map(s=>Math.round(num(s))).filter(n=>n>0).slice(0,4);
    if(qs.length) ex.quick=qs; else delete ex.quick;
  }
  uref('settings/exercises').set(EXERCISES).then(()=>{ toast('✏️ 保存しました'); openExerciseEditor(); render(); });
}
function delExercise(i){
  if(!confirm('「'+EXERCISES[i].name+'」を削除しますか?(過去の記録は残ります)')) return;
  EXERCISES.splice(i,1); uref('settings/exercises').set(EXERCISES).then(()=>{ toast('削除しました'); openExerciseEditor(); render(); });
}

/* ---------- account ---------- */
function openAcct(){
  sheet(`<h3>アカウント</h3>
    <div class="card" style="background:var(--card)"><div class="tiny muted">ログイン中</div><div style="font-weight:700">${esc(auth.currentUser.email||'')}</div></div>
    <button class="btn ghost block" style="margin-bottom:8px" onclick="openGoalSheet()">⚙️ 目標値を設定</button>
    <button class="btn ghost block" style="margin-bottom:8px" onclick="openShortcutSheet()">📲 iPhone歩数 自動連携の設定</button>
    <button class="btn block" onclick="doLogout()">ログアウト</button>`);
}

/* ---------- Phase 2-A: iPhoneショートカット連携設定 ---------- */
function openShortcutSheet(){
  const u=uid||'(ログインしてください)';
  const dbBase=FIREBASE_CONFIG.databaseURL;
  const apiKey=FIREBASE_CONFIG.apiKey;
  sheet(`<h3>📲 iPhone歩数・睡眠の自動連携</h3>
    <div class="tiny muted" style="margin-bottom:12px">iPhoneの「ショートカット」アプリで毎朝ヘルスケアの歩数・睡眠を自動送信します。下の値をコピーして使ってください(設定は初回のみ)。</div>
    <div class="card" style="background:var(--card)">
      <div class="tiny muted">あなたのユーザーID (uid)</div>
      <div class="row between"><code style="font-size:12px;word-break:break-all">${esc(u)}</code>
        <button class="btn sm" onclick="copyTxt('${esc(u)}')">コピー</button></div>
    </div>
    <div class="card" style="background:var(--card)">
      <div class="tiny muted">書き込み先URL (歩数・本日分)</div>
      <div class="row between"><code style="font-size:11px;word-break:break-all">${esc(dbBase)}/healthData/${esc(u)}/days/【日付】/steps.json</code>
        <button class="btn sm" onclick="copyTxt('${esc(dbBase)}/healthData/${esc(u)}/days/')">コピー</button></div>
    </div>
    <div class="card" style="background:var(--card)">
      <button class="btn primary block" onclick="copyShortcutRecipe()">📋 セットアップ手順を全文コピー</button>
      <div class="tiny muted" style="margin-top:8px">手順テキスト(ログイン情報を埋めた完全版)をコピーします。Apple純正ショートカットで、①Firebaseログイン→②歩数取得→③送信、を組みます。</div>
    </div>
    <details style="margin-top:6px"><summary class="tiny muted" style="cursor:pointer">仕組み(技術メモ)</summary>
      <div class="tiny muted" style="margin-top:8px;line-height:1.6">
        ショートカットが Firebase Auth REST でメール/パスワードログイン → idToken取得 → ヘルスケアの歩数を当日パスに PUT します。
        認証必須なので他人は書き込めません(ルールで保護)。Phase 2の完全自動化(ワンタップ配布用ショートカット)は次段で用意します。
      </div>
    </details>`);
}
function copyTxt(t){ navigator.clipboard&&navigator.clipboard.writeText(t).then(()=>toast('コピーしました'),()=>toast('コピー失敗')); }
function copyShortcutRecipe(){
  const u=uid, dbBase=FIREBASE_CONFIG.databaseURL, apiKey=FIREBASE_CONFIG.apiKey, email=auth.currentUser.email||'';
  const recipe=`【HealthBoard iPhone歩数 自動連携ショートカット 手順】

■ 用意するもの
- あなたのログインメール: ${email}
- パスワード: (HealthBoardのログインパスワード)
- uid: ${u}

■ ショートカットアプリで以下を作成 (アクションを上から順に追加)

1) [テキスト] 次を入力:
   ${email}
   → 変数名「EMAIL」で保存

2) [テキスト] パスワードを入力 → 変数名「PASS」で保存

3) [URLの内容を取得]
   URL: https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}
   方法: POST / 本文: JSON
   {"email": EMAIL, "password": PASS, "returnSecureToken": true}
   → 返ってきたJSONの「idToken」を取得 (辞書から値を取得)、変数「TOKEN」

4) [現在の日付] を取得 → [日付をフォーマット] 形式 yyyy-MM-dd → 変数「TODAY」

5) [ヘルスケアからサンプルを取得] 種類:歩数 / 期間:今日 / 集計:合計 → 変数「STEPS」

6) [URLの内容を取得]
   URL: ${dbBase}/healthData/${u}/days/【TODAY】/steps.json?auth=【TOKEN】
   方法: PUT / 本文: STEPS (数値そのまま)

7) (任意) 睡眠も同様に種類:睡眠 → .../sleep.json へ PUT

■ 体重連携(測った日だけ・/ingest 方式が簡単)
別ショートカット or 既存に追記:
- [ヘルスケアサンプルを検索] 種類:体重 / 開始日:今日 / 制限1件 → [if 件数>0] のときだけ実行
- [URLの内容を取得] URL: ${AI_WORKER_URL}/ingest 方法:POST 本文:JSON / key=送信キー(hbk_… 歩数と同じ) / weight=体重値 / day=today(前日確定なら yesterday)
体脂肪は種類を「体脂肪率」にして fat フィールドで同様に。測ってない日はヘルスケアに値が無く送信されない=記録なし。

■ 自動化
ショートカット → オートメーション → 毎朝7:00 に上記を実行(確認なし)に設定。

※ うまくいかない時は手順をスクショで送ってください。完全自動配布版(タップ1つでインストール)も次段で用意します。`;
  copyToClipViaTemp(recipe);
}
function copyToClipViaTemp(t){ navigator.clipboard?navigator.clipboard.writeText(t).then(()=>toast('📋 手順をコピーしました'),()=>toast('コピー失敗')):toast('コピー不可'); }
function doLogout(){ auth.signOut().then(()=>{ closeSheet(); toast('ログアウトしました'); }); }

/* ===================== nav ===================== */
function setTab(t){ curTab=t; q('.tabbar').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t)); render(); }
// ヘッダーのタイトルタップ: 今日のホームへ (タブ=Home + 日付=今日)
function goHomeToday(){
  const backDate = curDate!==todayStr();
  if(backDate) curDate=todayStr();
  if(curTab!=='Home') setTab('Home');
  if(backDate) watchDay();          // 日付が変わった時のみ購読し直す (setTab未実行でも再描画)
  window.scrollTo(0,0);
}
function q(s){ return document.querySelector(s); }

function bindEvents(){
  q('#loginBtn').onclick=doLogin; q('#signupBtn').onclick=doSignup;
  q('#loginPass').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
  q('.tabbar').querySelectorAll('button').forEach(b=> b.onclick=()=>setTab(b.dataset.tab));
  q('#fab').onclick=()=>{ if(curTab==='Workout'){ openExerciseEditor(); } else if(curTab==='Body'){ openBodySheet(); } else { openMealSheet(); } };
  q('#acctBtn').onclick=openAcct;
  q('.h-title').onclick=goHomeToday;
  q('#prevDay').onclick=()=>{ curDate=shiftDate(curDate,-1); watchDay(); };
  q('#nextDay').onclick=()=>{ if(curDate<todayStr()){ curDate=shiftDate(curDate,1); watchDay(); } };
  q('#curDate').onclick=()=>{ if(curDate!==todayStr()){ curDate=todayStr(); watchDay(); toast('今日に戻りました'); } };
  q('#resetBtn').onclick=doReset;
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeSheet(); });
  new MutationObserver(_syncBodyLock).observe(q('#modalRoot'),{childList:true});
}

window.addEventListener('DOMContentLoaded',()=>{ bindEvents(); initFirebase(); });
if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(()=>{}); }
