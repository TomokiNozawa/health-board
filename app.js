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
  water: 2000,          // 水分 ml
  steps: 12000,         // 歩数
};

// ---- 既定の筋トレ種目 (ユーザーが追加・編集可) ----
const DEFAULT_EXERCISES = [
  { id:'yt_abs',   name:'YouTube腹筋', type:'check', icon:'📺' },
  { id:'squat',    name:'スクワット',  type:'count', unit:'回', icon:'🦵' },
  { id:'situp',    name:'腹筋',        type:'count', unit:'回', icon:'🔥' },
  { id:'tachikoro',name:'立ちコロ',    type:'count', unit:'回', icon:'🎡' },
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
function blankDay(){ return { meals:{}, workout:{exercises:{},note:''}, body:{}, steps:null, sleep:null, water:0, mood:null }; }
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
  const cb = ref.on('value', snap=>{
    DAY = Object.assign(blankDay(), snap.val()||{});
    DAY.meals = DAY.meals||{}; DAY.workout = DAY.workout||{exercises:{},note:''};
    DAY.workout.exercises = DAY.workout.exercises||{}; DAY.body = DAY.body||{};
    render();
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

async function renderHome(){
  const el=q('#viewHome'); const t=mealTotals();
  const last = await getLastMealTime();
  const ref = curDate===todayStr() ? new Date() : new Date(curDate+'T23:59:59');
  let fastH=0, fasting=true, eatLabel='';
  if(last){
    fastH = (ref - last)/3600000;
    fasting = fastH < 24 ? true : true;
    eatLabel = '最後の食事 '+ String(last.getHours()).padStart(2,'0')+':'+String(last.getMinutes()).padStart(2,'0');
  }
  const pct = Math.max(0, Math.min(1, fastH/GOALS.fastHours));
  const done = fastH>=GOALS.fastHours;
  const remain = Math.max(0, GOALS.fastHours-fastH);
  const ringColor = done ? 'var(--green)' : 'var(--teal)';
  const circ = 2*Math.PI*88;
  // 達成予定時刻 = 最後の食事 + 目標時間
  const goalTime = last ? new Date(last.getTime()+GOALS.fastHours*3600000) : null;

  el.innerHTML = `
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

    <h2 class="sec">今日のPFCバランス</h2>
    <div class="card">
      ${pfcRow('P たんぱく質', t.p, 'var(--rose)')}
      ${pfcRow('F 脂質', t.f, 'var(--amber)')}
      ${pfcRow('C 炭水化物', t.c, 'var(--blue)')}
    </div>

    <h2 class="sec">クイック記録</h2>
    <div class="card">
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn primary grow" onclick="openMealSheet()">🍽 食事</button>
        <button class="btn amber grow" onclick="setTab('Workout')">💪 運動</button>
      </div>
      <div class="btn-row">
        <button class="btn grow" onclick="addWater(200)">💧 +200ml</button>
        <button class="btn grow" onclick="addWater(500)">💧 +500ml</button>
        <button class="btn grow" onclick="openBodySheet()">⚖️ 体重</button>
      </div>
    </div>`;
}
function fmtH(h){ const hh=Math.floor(h); const mm=Math.round((h-hh)*60); return mm>=60?(hh+1)+':00':hh+':'+String(mm).padStart(2,'0'); }
function fmtHM(h){ let total=Math.max(0,Math.round(h*60)); const hh=Math.floor(total/60), mm=total%60; return hh+'時間'+String(mm).padStart(2,'0')+'分'; }
function fmtDateTime(d){ if(!d) return '—'; const M=d.getMonth()+1, D=d.getDate(), w=['日','月','火','水','木','金','土'][d.getDay()];
  const hh=String(d.getHours()).padStart(2,'0'), mm=String(d.getMinutes()).padStart(2,'0');
  const ds=todayStr(d); const lbl = ds===todayStr()?'今日':(ds===shiftDate(todayStr(),1)?'明日':(ds===shiftDate(todayStr(),-1)?'昨日':`${M}/${D}(${w})`));
  return `${lbl} ${hh}:${mm}`; }
function tile(lab,val,goal,unit,color){
  const pct = goal? Math.min(100, (num(val)/goal)*100):0;
  return `<div class="tile"><div class="lab">${lab}</div>
    <div class="val mono">${val}<small> / ${goal}${unit}</small></div>
    <div class="bar"><i style="width:${pct}%;background:${color}"></i></div></div>`;
}
function pfcRow(lab,g,color){
  return `<div class="row between" style="padding:7px 0"><span class="muted tiny">${lab}</span>
    <span class="mono" style="font-weight:700;color:${color}">${d1(g)} g</span></div>`;
}

/* ---------- Meals view ---------- */
function renderMeals(){
  const el=q('#viewMeals'); const t=mealTotals();
  const keys=Object.keys(DAY.meals).sort((a,b)=>(DAY.meals[a].at||'').localeCompare(DAY.meals[b].at||''));
  el.innerHTML = `
    <div class="card">
      <div class="row between">
        <div><div class="tiny muted">合計</div><div class="big mono">${Math.round(t.kcal)}<small style="font-size:14px;color:var(--sub)"> kcal</small></div></div>
        <div class="tiny muted" style="text-align:right">
          P ${d1(t.p)}g ・ F ${d1(t.f)}g ・ C ${d1(t.c)}g<br>${t.n} 件
        </div>
      </div>
      <button class="btn primary block" style="margin-top:12px" onclick="openMealSheet()">🍽 食事を追加</button>
    </div>
    <div class="card">
      ${keys.length? keys.map(k=>{
        const m=DAY.meals[k];
        return `<div class="item">
          <div class="ico">${m.photo?'📷':'🍽️'}</div>
          <div class="meta"><div class="nm">${esc(m.name||'食事')}</div>
            <div class="sb">${esc(m.at||'')} ・ P${d1(m.p)} F${d1(m.f)} C${d1(m.c)}</div></div>
          <div class="amt">${Math.round(num(m.kcal))}<div class="tiny muted">kcal</div></div>
          <button class="del" onclick="delMeal('${k}')">🗑</button>
        </div>`;
      }).join('') : '<div class="empty">まだ記録がありません</div>'}
    </div>`;
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
        return `<div class="card">
          <div class="row between"><div class="row" style="gap:10px"><span style="font-size:22px">${ex.icon||'🏋️'}</span><b>${esc(ex.name)}</b></div>
            <div class="counter">
              <button onclick="bumpCount('${ex.id}',-5)">−</button>
              <span class="n mono">${n}</span>
              <button onclick="bumpCount('${ex.id}',5)">＋</button>
            </div></div>
          <div class="row" style="gap:8px;margin-top:8px;justify-content:flex-end">
            <button class="btn sm" onclick="bumpCount('${ex.id}',-1)">−1</button>
            <button class="btn sm" onclick="bumpCount('${ex.id}',1)">+1</button>
            <button class="btn sm" onclick="bumpCount('${ex.id}',10)">+10</button>
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
      ${bodyTile('💧','水分', DAY.water||0, 'ml','openWaterSheet()')}
      ${bodyTile('😴','睡眠', DAY.sleep, 'h','openSleepSheet()')}
    </div>
    <h2 class="sec">体調・気分</h2>
    <div class="card">
      <div class="chips">
        ${['😣 不調','😐 普通','😊 好調'].map((m,i)=>`<button class="chip ${DAY.mood===i?'on':''}" onclick="setMood(${i})">${m}</button>`).join('')}
      </div>
    </div>
    <h2 class="sec">歩数・睡眠</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:10px">Phase 2 で iPhoneショートカット自動連携予定。今は手入力できます。</div>
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
async function renderStats(){
  const el=q('#viewStats');
  el.innerHTML=`<div class="empty">7日間のデータを集計中…</div>`;
  const days=[]; for(let i=6;i>=0;i--) days.push(shiftDate(todayStr(),-i));
  const snaps=await Promise.all(days.map(d=> uref('days/'+d).once('value').then(s=>s.val()||{}) ));
  const data=days.map((d,i)=>{
    const v=snaps[i]; let kcal=0,p=0;
    const meals=(v.meals)||{}; for(const k in meals){ kcal+=num(meals[k].kcal); p+=num(meals[k].p); }
    return { date:d, kcal:Math.round(kcal), protein:Math.round(p), steps:v.steps||0, weight:(v.body&&v.body.weight)||null };
  });
  // fasting streak
  let streak=0; const allDays=await uref('days').once('value').then(s=>s.val()||{});
  const sortedDates=Object.keys(allDays).sort().reverse();
  // (簡易: meals 件数>0 かつ 最初と最後の食事間が 8h 以内なら達成扱い)
  for(const ds of sortedDates){
    const meals=allDays[ds].meals||{}; const ats=Object.values(meals).map(m=>m.at).filter(Boolean).sort();
    if(ats.length<1) break;
    const span = ats.length>=2 ? hhDiff(ats[0],ats[ats.length-1]) : 0;
    if(span <= (24-GOALS.fastHours)+0.5) streak++; else break;
  }
  const maxK=Math.max(GOALS.calorie, ...data.map(d=>d.kcal),1);
  const maxS=Math.max(GOALS.steps, ...data.map(d=>d.steps),1);
  const weights=data.filter(d=>d.weight!=null);
  el.innerHTML=`
    <div class="card row between">
      <div><div class="tiny muted">ファスティング連続達成</div><div class="streak">🔥 ${streak} 日</div></div>
      <div style="text-align:right"><div class="tiny muted">平均カロリー(7日)</div>
        <div class="big mono" style="font-size:22px">${Math.round(data.reduce((a,d)=>a+d.kcal,0)/7)}</div></div>
    </div>
    <h2 class="sec">カロリー (7日)</h2>
    <div class="card"><div class="chartbox">
      ${data.map(d=>{const h=(d.kcal/maxK)*100;return `<div class="col"><div class="vlab">${d.kcal?d.kcal.toLocaleString():''}</div><div class="bb amber" style="height:${h}%"></div><div class="lab">${d.date.slice(8)}</div></div>`}).join('')}
    </div><div class="legend"><span><i style="background:var(--amber)"></i>kcal/日 ・ 目標 ${GOALS.calorie}</span></div></div>
    <h2 class="sec">歩数 (7日)</h2>
    <div class="card"><div class="chartbox">
      ${data.map(d=>{const h=(d.steps/maxS)*100;return `<div class="col"><div class="vlab">${d.steps?d.steps.toLocaleString():''}</div><div class="bb blue" style="height:${h}%"></div><div class="lab">${d.date.slice(8)}</div></div>`}).join('')}
    </div><div class="legend"><span><i style="background:var(--blue)"></i>歩/日 ・ 目標 ${GOALS.steps}</span></div></div>
    <h2 class="sec">体重推移</h2>
    <div class="card">${weights.length? weights.map(d=>`<div class="row between" style="padding:6px 0"><span class="tiny muted">${d.date}</span><span class="mono" style="font-weight:700">${d.weight} kg</span></div>`).join('') : '<div class="empty">体重を記録すると推移が出ます</div>'}</div>
    <div style="height:8px"></div>
    <button class="btn ghost block" onclick="openGoalSheet()">⚙️ 目標値を設定</button>`;
}
function hhDiff(a,b){ const pa=a.split(':'),pb=b.split(':'); return (pb[0]*60+ +pb[1]-(pa[0]*60+ +pa[1]))/60; }

/* ===================== WRITES ===================== */
function delMeal(k){ if(confirm('この食事を削除しますか?')) uref('days/'+curDate+'/meals/'+k).remove().then(()=>toast('削除しました')); }
function addWater(ml){ const v=(DAY.water||0)+ml; uref('days/'+curDate+'/water').set(v).then(()=>toast('💧 +'+ml+'ml')); }
function setMood(i){ uref('days/'+curDate+'/mood').set(i); }
function toggleCheck(id){ const cur=DAY.workout.exercises[id]; const nv=!(cur&&cur.done);
  uref('days/'+curDate+'/workout/exercises/'+id).set({done:nv}).then(()=>nv&&toast('✅ 完了!')); }
function bumpCount(id,delta){ const cur=DAY.workout.exercises[id]; const n=Math.max(0,(cur?num(cur.count):0)+delta);
  uref('days/'+curDate+'/workout/exercises/'+id).set({count:n}); }
function saveWoNote(){ const v=q('#woNote').value; uref('days/'+curDate+'/workout/note').set(v); }

/* ===================== SHEETS (modals) ===================== */
function closeSheet(){ q('#modalRoot').innerHTML=''; }
function sheet(html){
  q('#modalRoot').innerHTML=`<div class="scrim" onclick="if(event.target===this)closeSheet()">
    <div class="sheet"><div class="grip"></div>${html}</div></div>`;
}

function foodMasterList(){
  return Object.entries(FOOD_MASTER).map(([id,f])=>({id,...f}))
    .sort((a,b)=>(b.uses||0)-(a.uses||0) || (b.ts||0)-(a.ts||0));
}
function openMealSheet(){
  const fav=foodMasterList();
  const favHtml = fav.length ? `
    <div class="field">
      <label>マイ食品から選ぶ <span class="muted">(${fav.length}件)</span></label>
      <input id="foodSearch" placeholder="🔍 名前で絞り込み" oninput="renderFoodChips(this.value)" style="margin-bottom:8px">
      <div id="foodChips" class="food-chips"></div>
    </div>
    <div class="or-sep"><span>または手入力 / 写真</span></div>` : '';
  sheet(`<h3>🍽 食事を記録</h3>
    ${favHtml}
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
    <div class="field"><label>食事時刻</label><input id="mAt" type="time" value="${nowHHMM()}"></div>
    <div class="two">
      <div class="field"><label>カロリー (kcal)</label><input id="mKcal" type="number" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>たんぱく質 (g)</label><input id="mP" type="number" inputmode="decimal" step="0.1" placeholder="0.0"></div>
    </div>
    <div class="two">
      <div class="field"><label>脂質 (g)</label><input id="mF" type="number" inputmode="decimal" step="0.1" placeholder="0.0"></div>
      <div class="field"><label>炭水化物 (g)</label><input id="mC" type="number" inputmode="decimal" step="0.1" placeholder="0.0"></div>
    </div>
    <button class="btn primary block" onclick="saveMeal()">保存</button>`);
  if(foodMasterList().length) renderFoodChips('');
}
function renderFoodChips(filter){
  const box=q('#foodChips'); if(!box) return;
  const f=(filter||'').trim();
  let list=foodMasterList();
  if(f) list=list.filter(x=>x.name.includes(f));
  list=list.slice(0,30);
  box.innerHTML = list.length ? list.map(x=>
    `<button class="food-chip" onclick='pickFood("${x.id}")'>
       <span class="fc-name">${esc(x.name)}</span>
       <span class="fc-kcal">${Math.round(num(x.kcal))}kcal</span>
       <span class="fc-del" onclick='event.stopPropagation();delFood("${x.id}")'>×</span>
     </button>`).join('') : '<div class="tiny muted" style="padding:4px">該当なし</div>';
}
function pickFood(id){
  const f=FOOD_MASTER[id]; if(!f) return;
  q('#mName').value=f.name||''; q('#mKcal').value=f.kcal||''; q('#mP').value=f.p||''; q('#mF').value=f.f||''; q('#mC').value=f.c||'';
  const st=q('#aiStatus'); if(st) st.textContent='✅ マイ食品「'+(f.name||'')+'」を反映 (時刻を確認して保存)';
  toast('「'+(f.name||'')+'」を反映');
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
  const m={ name:q('#mName').value.trim()||'食事', at:q('#mAt').value||nowHHMM(),
    kcal:num(q('#mKcal').value), p:num(q('#mP').value), f:num(q('#mF').value), c:num(q('#mC').value), ts:Date.now() };
  uref('days/'+curDate+'/meals/'+uuid()).set(m).then(()=>{ closeSheet(); toast('🍽 記録しました'); });
  upsertFoodMaster(m);
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
    <button class="btn primary block" onclick="saveBody()">保存</button>`);
  setTimeout(()=>q('#bW')&&q('#bW').focus(),200);
}
function saveBody(){
  const upd={}; const w=q('#bW').value, f=q('#bF').value;
  if(w!=='') upd.weight=num(w); if(f!=='') upd.fat=num(f);
  uref('days/'+curDate+'/body').update(upd).then(()=>{ closeSheet(); toast('⚖️ 記録しました'); });
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
    <div class="two">
      <div class="field"><label>たんぱく質 (g)</label><input id="gPro" type="number" inputmode="numeric" value="${GOALS.protein}"></div>
      <div class="field"><label>水分 (ml)</label><input id="gWat" type="number" inputmode="numeric" value="${GOALS.water}"></div>
    </div>
    <div class="field"><label>歩数</label><input id="gStep" type="number" inputmode="numeric" value="${GOALS.steps}"></div>
    <button class="btn primary block" onclick="saveGoals()">保存</button>`);
}
function saveGoals(){
  GOALS={ fastHours:num(q('#gFast').value)||16, calorie:num(q('#gCal').value)||2000,
    protein:num(q('#gPro').value)||120, water:num(q('#gWat').value)||2000, steps:num(q('#gStep').value)||12000 };
  uref('settings/goals').set(GOALS).then(()=>{ closeSheet(); toast('⚙️ 目標を更新'); render(); });
}

/* ---------- 種目エディタ ---------- */
function openExerciseEditor(){
  sheet(`<h3>⚙️ 筋トレ種目の編集</h3>
    <div id="exList">${EXERCISES.map((ex,i)=>exEditRow(ex,i)).join('')}</div>
    <h2 class="sec">新しい種目を追加</h2>
    <div class="field"><label>種目名</label><input id="exNewName" placeholder="例: プランク"></div>
    <div class="field"><label>記録タイプ</label>
      <div class="seg"><button id="exTypeCount" class="on" onclick="pickExType('count')">回数で記録</button>
        <button id="exTypeCheck" onclick="pickExType('check')">やった/やってない</button></div></div>
    <div class="field" id="exUnitWrap"><label>単位</label><input id="exNewUnit" value="回" placeholder="回 / 秒 / 分"></div>
    <button class="btn primary block" onclick="addExercise()">＋ 種目を追加</button>
    <button class="btn ghost block" style="margin-top:8px" onclick="closeSheet()">閉じる</button>`);
}
let _newExType='count';
function pickExType(t){ _newExType=t; q('#exTypeCount').classList.toggle('on',t==='count'); q('#exTypeCheck').classList.toggle('on',t==='check'); q('#exUnitWrap').style.display=t==='count'?'block':'none'; }
function exEditRow(ex,i){
  return `<div class="item"><div class="ico">${ex.icon||'🏋️'}</div>
    <div class="meta"><div class="nm">${esc(ex.name)}</div><div class="sb">${ex.type==='check'?'チェック式':'回数式 ('+esc(ex.unit||'回')+')'}</div></div>
    <button class="del" onclick="delExercise(${i})">🗑</button></div>`;
}
function addExercise(){
  const name=q('#exNewName').value.trim(); if(!name){ toast('種目名を入力してください'); return; }
  const ex={ id:uuid(), name, type:_newExType, icon:'🏋️' };
  if(_newExType==='count') ex.unit=q('#exNewUnit').value.trim()||'回';
  EXERCISES.push(ex); uref('settings/exercises').set(EXERCISES).then(()=>{ toast('種目を追加'); openExerciseEditor(); });
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

■ 自動化
ショートカット → オートメーション → 毎朝7:00 に上記を実行(確認なし)に設定。

※ うまくいかない時は手順をスクショで送ってください。完全自動配布版(タップ1つでインストール)も次段で用意します。`;
  copyToClipViaTemp(recipe);
}
function copyToClipViaTemp(t){ navigator.clipboard?navigator.clipboard.writeText(t).then(()=>toast('📋 手順をコピーしました'),()=>toast('コピー失敗')):toast('コピー不可'); }
function doLogout(){ auth.signOut().then(()=>{ closeSheet(); toast('ログアウトしました'); }); }

/* ===================== nav ===================== */
function setTab(t){ curTab=t; q('.tabbar').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t)); render(); }
function q(s){ return document.querySelector(s); }

function bindEvents(){
  q('#loginBtn').onclick=doLogin; q('#signupBtn').onclick=doSignup;
  q('#loginPass').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
  q('.tabbar').querySelectorAll('button').forEach(b=> b.onclick=()=>setTab(b.dataset.tab));
  q('#fab').onclick=()=>{ if(curTab==='Workout'){ openExerciseEditor(); } else if(curTab==='Body'){ openBodySheet(); } else { openMealSheet(); } };
  q('#acctBtn').onclick=openAcct;
  q('#prevDay').onclick=()=>{ curDate=shiftDate(curDate,-1); watchDay(); };
  q('#nextDay').onclick=()=>{ if(curDate<todayStr()){ curDate=shiftDate(curDate,1); watchDay(); } };
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeSheet(); });
}

window.addEventListener('DOMContentLoaded',()=>{ bindEvents(); initFirebase(); });
if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(()=>{}); }
