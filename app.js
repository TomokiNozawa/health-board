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
  steps: 8000,          // 歩数
};

// ---- 既定の筋トレ種目 (ユーザーが追加・編集可) ----
const DEFAULT_EXERCISES = [
  { id:'yt_abs',   name:'YouTube腹筋', type:'check', icon:'📺' },
  { id:'squat',    name:'スクワット',  type:'count', unit:'回', icon:'🦵' },
  { id:'situp',    name:'腹筋',        type:'count', unit:'回', icon:'🔥' },
  { id:'tachikoro',name:'立ちコロ',    type:'count', unit:'回', icon:'🎡' },
];

let app, auth, db, uid=null;
let GOALS = {...DEFAULT_GOALS};
let EXERCISES = [...DEFAULT_EXERCISES];
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
            <div class="l">絶食時間 ${last?'/ 目標'+GOALS.fastHours+'h':''}</div>
          </div>
        </div>
        <div class="fast-state ${done?'fasting':'eating'}">
          ${!last ? '🍽 食事を記録すると計測開始' : done ? '✅ 目標達成！' : '⏳ 達成まであと '+fmtH(remain)}
        </div>
        <div class="tiny muted">${esc(eatLabel)}</div>
      </div>
    </div>

    <div class="tiles">
      ${tile('🔥 カロリー', Math.round(t.kcal), GOALS.calorie, 'kcal', 'var(--amber)')}
      ${tile('🥩 たんぱく質', Math.round(t.p), GOALS.protein, 'g', 'var(--rose)')}
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
function tile(lab,val,goal,unit,color){
  const pct = goal? Math.min(100, (num(val)/goal)*100):0;
  return `<div class="tile"><div class="lab">${lab}</div>
    <div class="val mono">${val}<small> / ${goal}${unit}</small></div>
    <div class="bar"><i style="width:${pct}%;background:${color}"></i></div></div>`;
}
function pfcRow(lab,g,color){
  return `<div class="row between" style="padding:7px 0"><span class="muted tiny">${lab}</span>
    <span class="mono" style="font-weight:700;color:${color}">${Math.round(g)} g</span></div>`;
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
          P ${Math.round(t.p)}g ・ F ${Math.round(t.f)}g ・ C ${Math.round(t.c)}g<br>${t.n} 件
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
            <div class="sb">${esc(m.at||'')} ・ P${Math.round(num(m.p))} F${Math.round(num(m.f))} C${Math.round(num(m.c))}</div></div>
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
      ${data.map(d=>{const h=(d.kcal/maxK)*100;return `<div class="col"><div class="bb amber" style="height:${h}%"></div><div class="lab">${d.date.slice(8)}</div></div>`}).join('')}
    </div><div class="legend"><span><i style="background:var(--amber)"></i>kcal/日 ・ 目標 ${GOALS.calorie}</span></div></div>
    <h2 class="sec">歩数 (7日)</h2>
    <div class="card"><div class="chartbox">
      ${data.map(d=>{const h=(d.steps/maxS)*100;return `<div class="col"><div class="bb blue" style="height:${h}%"></div><div class="lab">${d.date.slice(8)}</div></div>`}).join('')}
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

function openMealSheet(){
  sheet(`<h3>🍽 食事を記録</h3>
    <div class="card" style="background:var(--card);margin-bottom:14px">
      <div class="tiny muted" style="margin-bottom:8px">📷 写真AI推定は Phase 2 で実装予定です</div>
      <button class="btn block" disabled style="opacity:.5">📷 写真から推定（近日）</button>
    </div>
    <div class="field"><label>料理名</label><input id="mName" placeholder="例: 鶏むね定食"></div>
    <div class="field"><label>食事時刻</label><input id="mAt" type="time" value="${nowHHMM()}"></div>
    <div class="two">
      <div class="field"><label>カロリー (kcal)</label><input id="mKcal" type="number" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>たんぱく質 (g)</label><input id="mP" type="number" inputmode="decimal" placeholder="0"></div>
    </div>
    <div class="two">
      <div class="field"><label>脂質 (g)</label><input id="mF" type="number" inputmode="decimal" placeholder="0"></div>
      <div class="field"><label>炭水化物 (g)</label><input id="mC" type="number" inputmode="decimal" placeholder="0"></div>
    </div>
    <button class="btn primary block" onclick="saveMeal()">保存</button>`);
  setTimeout(()=>q('#mName')&&q('#mName').focus(),200);
}
function saveMeal(){
  const m={ name:q('#mName').value.trim()||'食事', at:q('#mAt').value||nowHHMM(),
    kcal:num(q('#mKcal').value), p:num(q('#mP').value), f:num(q('#mF').value), c:num(q('#mC').value), ts:Date.now() };
  uref('days/'+curDate+'/meals/'+uuid()).set(m).then(()=>{ closeSheet(); toast('🍽 記録しました'); });
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
    protein:num(q('#gPro').value)||120, water:num(q('#gWat').value)||2000, steps:num(q('#gStep').value)||8000 };
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
    <button class="btn block" onclick="doLogout()">ログアウト</button>`);
}
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
