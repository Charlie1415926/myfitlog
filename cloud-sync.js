/* MyFitLog, isolated catalogs v2.
 * Guests: catalog/exercises/items (public, read only).
 * Admin: edits same public catalog; private workout records.
 * Members: users/{uid}/personalExercises (a one-time independent copy);
 *          users/{uid}/records (private workout logs).
 * Former overrides/exercises are READ ONLY sources for one-time migration.
 */
const $ = q => document.querySelector(q);
const cfg = window.FIREBASE_CONFIG || {};
const adminEmail = String(window.FIREBASE_ADMIN_EMAIL || '').trim().toLowerCase();
const configured = Boolean(cfg.apiKey && cfg.projectId && cfg.appId && cfg.authDomain);
const login = $('#googleLogin'), logout = $('#googleLogout');
const cloudUser = $('#cloudUser'), cloudStatus = $('#cloudStatus'), cloudBusy = $('#cloudBusy');
const status = s => { if(cloudStatus)cloudStatus.textContent=s; };
const copy = x => JSON.parse(JSON.stringify(x));
const key = x => String(x.id);
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
let sdk=null,user=null,isAdmin=false,catalogReady=false,publicLoaded=false;
let shared=new Map(),personal=new Map(),records=new Map(),recovery=new Map();
let personalLoaded=false,recordsLoaded=false;
let unsubs=[],generation=0,pendingShared=new Map(),pendingPersonal=new Map(),pendingRecords=new Map();
let timer=null,writing=false,lastError=null,migrating=false;
const ownHistory=e=>Array.isArray(e.history)?copy(e.history):[];
function withoutHistory(e){const out=copy(e);delete out.history;delete out.rpe;return out;}
function isReady(){return Boolean(user&&catalogReady&&recordsLoaded&&(isAdmin?publicLoaded:personalLoaded));}
function busy(show,notice='正在載入資料…'){
  if(!cloudBusy)return;cloudBusy.hidden=!show;
  if(show){const el=$('#cloudBusyText');if(el)el.textContent=notice;}
}
function roleUI(){
 document.body.classList.toggle('cloud-guest',!user);
 document.body.classList.remove('cloud-viewer');
 if(login)login.hidden=!!user;if(logout)logout.hidden=!user;
 if(cloudUser)cloudUser.textContent=!user?'訪客（只讀公用動作）':
   (user.displayName||user.email||'Google 使用者')+(isAdmin?' · 管理員（公用動作）':' · 獨立私人動作庫');
 const publish=$('#publishCatalog');if(publish)publish.hidden=!user||!isAdmin||catalogReady;
 const note=$('#currentUserUid');if(note)note.textContent=user&&!isAdmin?'私人動作及訓練紀錄獨立儲存；管理員更新公用動作不會修改你的動作。':'';
}
function merged(base,pending){const out=new Map(base);for(const [id,v] of pending){if(v===null)out.delete(id);else out.set(id,v);}return out;}
function effectiveRecord(id){if(pendingRecords.has(id))return copy(pendingRecords.get(id)||[]);return copy(records.get(id)||[]);}
function refresh(){
 const source=!user?merged(shared,pendingShared):
   (isAdmin?(catalogReady?merged(shared,pendingShared):recovery):merged(personal,pendingPersonal));
 const items=[...source].map(([id,e])=>({...copy(e),id,history:user&&recordsLoaded?effectiveRecord(id):[]}));
 window.StrengthApp.replaceExercises(items);
 if(!user)window.StrengthApp.showSearch();
}
function errorText(e){
 console.error('Firebase',e);
 if(e?.code==='permission-denied')return 'Firestore 權限不足，請先發布此版本的 firestore.rules';
 if(e?.code==='auth/unauthorized-domain')return 'Netlify 網域尚未加入 Firebase 授權';
 if(e?.code==='auth/popup-blocked')return '登入視窗被封鎖';
 return e?.message||'未知錯誤';
}
function stopListeners(){generation++;clearTimeout(timer);for(const f of unsubs)try{f();}catch{}unsubs=[];}
function publicListener(){
 const g=generation;
 const unsub=sdk.onSnapshot(sdk.collection(sdk.db,'catalog','exercises','items'),{includeMetadataChanges:true},snap=>{
   if(g!==generation)return;
   // Never merge admin's live shared list into a signed-in member's private copy.
   if(user&&!isAdmin)return;
   if(snap.metadata.fromCache&&!publicLoaded)return;
   shared=new Map(snap.docs.map(d=>[d.id,{...d.data(),id:d.id}]));publicLoaded=true;
   refresh();
   if(!snap.metadata.fromCache&&!writing)status(catalogReady?'共用動作庫已載入':'共用動作庫尚未發布');
 },e=>status('公用動作載入失敗：'+errorText(e)));
 unsubs.push(unsub);
}
function personalListener(){
 const uid=user.uid,g=generation;
 const unsub=sdk.onSnapshot(sdk.collection(sdk.db,'users',uid,'personalExercises'),{includeMetadataChanges:true},snap=>{
  if(g!==generation||user?.uid!==uid)return;
  if(snap.metadata.fromCache&&!personalLoaded)return;
  personal=new Map(snap.docs.map(d=>[d.id,{...d.data(),id:d.id}]));personalLoaded=true;
  refresh();
  if(!snap.metadata.fromCache&&!writing&&!pendingPersonal.size)status('獨立私人動作庫已同步');
 },e=>status('私人動作讀取失敗：'+errorText(e)));
 unsubs.push(unsub);
}
function recordListener(){
 const uid=user.uid,g=generation;
 const unsub=sdk.onSnapshot(sdk.collection(sdk.db,'users',uid,'records'),{includeMetadataChanges:true},snap=>{
  if(g!==generation||user?.uid!==uid)return;
  if(snap.metadata.fromCache&&!recordsLoaded)return;
  records=new Map(snap.docs.map(d=>[d.id,Array.isArray(d.data().history)?d.data().history:[]]));recordsLoaded=true;
  refresh();
  if(!snap.metadata.fromCache&&!writing&&!pendingRecords.size)status('私人訓練紀錄已同步');
 },e=>status('私人訓練紀錄讀取失敗：'+errorText(e)));
 unsubs.push(unsub);
}
async function loadCatalogMetadata(){
 const d=await sdk.getDocFromServer(sdk.doc(sdk.db,'catalog','exercises'));
 catalogReady=d.exists()&&d.data()?.initialized===true;
}
async function migrateRecords(u,g){
 const uid=u.uid,marker=sdk.doc(sdk.db,'users',uid,'settings','migration');
 const [m,saved]=await Promise.all([sdk.getDocFromServer(marker),sdk.getDocsFromServer(sdk.collection(sdk.db,'users',uid,'records'))]);
 if(g!==generation||m.data()?.done)return;
 if(!saved.empty){await sdk.setDoc(marker,{done:true,source:'already-present'});return;}
 const old=await sdk.getDocsFromServer(sdk.collection(sdk.db,'users',uid,'exercises'));
 if(g!==generation)return;
 const histories=old.docs.map(d=>({id:d.id,history:ownHistory(d.data())})).filter(x=>x.history.length);
 for(let i=0;i<histories.length;i+=200){
  const batch=sdk.writeBatch(sdk.db);
  for(const x of histories.slice(i,i+200))batch.set(sdk.doc(sdk.db,'users',uid,'records',x.id),{history:x.history});
  await batch.commit();if(g!==generation)return;
 }
 await sdk.setDoc(marker,{done:true,source:'legacy-exercises',count:histories.length});
}
async function initializePersonalCatalog(u,g){
 // The migration marker is the switch. The shared catalog is copied ONCE, not merged on every login.
 const uid=u.uid,marker=sdk.doc(sdk.db,'users',uid,'settings','private-catalog-v2');
 const marked=await sdk.getDocFromServer(marker);
 if(g!==generation||marked.data()?.initialized)return;
 const [base,ov,existing,legacy]=await Promise.all([
  sdk.getDocsFromServer(sdk.collection(sdk.db,'catalog','exercises','items')),
  sdk.getDocsFromServer(sdk.collection(sdk.db,'users',uid,'overrides')),
  sdk.getDocsFromServer(sdk.collection(sdk.db,'users',uid,'personalExercises')),
  sdk.getDocsFromServer(sdk.collection(sdk.db,'users',uid,'exercises'))
 ]);
 if(g!==generation)return;
 // Preserve previously created personal documents; overlay-specific changes take priority.
 const frozen=new Map(base.docs.map(d=>[d.id,withoutHistory({...d.data(),id:d.id})]));
 for(const d of ov.docs){const v=d.data();if(v.deleted===true)frozen.delete(d.id);else if(v.exercise)frozen.set(d.id,withoutHistory({...v.exercise,id:d.id}));}
 // Recover older personal additions without resurrecting the 82 Excel baseline.
 for(const d of legacy.docs){if(d.id.startsWith('custom-')&&!frozen.has(d.id))frozen.set(d.id,withoutHistory({...d.data(),id:d.id}));}
 for(const d of existing.docs)frozen.set(d.id,withoutHistory({...d.data(),id:d.id}));
 if(!base.docs.length&&!ov.docs.length&&!existing.docs.length&&!legacy.docs.length)
  throw Error('共用動作庫未含資料，已停止首次複製，避免建立空白會員庫');
 const missing=[...frozen].filter(([id])=>!existing.docs.some(d=>d.id===id));
 // A typical catalog contains ~82 items; a single atomic batch prevents half-completed initialization.
 if(missing.length<450){
  const batch=sdk.writeBatch(sdk.db);
  for(const [id,e] of missing)batch.set(sdk.doc(sdk.db,'users',uid,'personalExercises',id),e);
  batch.set(marker,{initialized:true,source:'shared-snapshot-plus-previous-private-edits',count:frozen.size,createdAt:new Date().toISOString()});
  await batch.commit();
 }else{
  // Large catalogs: idempotent partial batches, marker only after all documents land.
  for(let i=0;i<missing.length;i+=200){const batch=sdk.writeBatch(sdk.db);
   for(const [id,e] of missing.slice(i,i+200))batch.set(sdk.doc(sdk.db,'users',uid,'personalExercises',id),e);
   await batch.commit();if(g!==generation)return;
  }
  await sdk.setDoc(marker,{initialized:true,source:'shared-snapshot-plus-previous-private-edits',count:frozen.size,createdAt:new Date().toISOString()});
 }
}
async function legacyAdminPreview(u,g){
 const snap=await sdk.getDocsFromServer(sdk.collection(sdk.db,'users',u.uid,'exercises'));
 if(g!==generation)return;
 recovery=new Map(snap.docs.map(d=>[d.id,withoutHistory({...d.data(),id:d.id})]));
 if(recovery.size){refresh();status(`管理員舊版救援：讀取 ${recovery.size} 個動作。請先匯出備份再發布共用庫。`);}
}
async function loadSession(u){
 stopListeners();user=u;isAdmin=Boolean(u&&u.emailVerified===true&&u.providerData?.some(p=>p.providerId==='google.com')&&String(u.email||'').trim().toLowerCase()===adminEmail);
 catalogReady=false;publicLoaded=false;personalLoaded=false;recordsLoaded=false;
 shared=new Map();personal=new Map();records=new Map();recovery=new Map();
 pendingShared.clear();pendingPersonal.clear();pendingRecords.clear();writing=false;lastError=null;
 roleUI();refresh();busy(true,'正在載入資料與確認帳號…');
 const g=generation;
 try{
  await loadCatalogMetadata();if(g!==generation)return;
  if(!u){publicListener();status('訪客模式：只能讀取公用動作，沒有任何私人紀錄');}
  else if(isAdmin){
   if(!catalogReady)await legacyAdminPreview(u,g);
   if(g!==generation)return;
   if(catalogReady)publicListener();
   if(catalogReady){await migrateRecords(u,g);if(g!==generation)return;recordListener();}
   else status('共用動作庫尚未發布，管理員可先備份舊資料並發布');
  }else{
   if(!catalogReady)throw Error('管理員尚未發布共用動作庫，無法初始化會員私人動作');
   await initializePersonalCatalog(u,g);if(g!==generation)return;
   await migrateRecords(u,g);if(g!==generation)return;
   personalListener();recordListener();
   status('私人動作庫已獨立建立，正在載入…');
  }
  roleUI();refresh();
 }catch(e){if(g===generation)status('雲端載入失敗：'+errorText(e)+'。既有資料不會被清除。');}
 finally{if(g===generation)busy(false);}
}
async function publishCatalog(rows){
 if(!user||!isAdmin||!sdk||catalogReady||migrating)return;
 const list=rows.map(withoutHistory);if(!list.length){status('沒有可發布的動作');return;}
 if(!confirm(`發布 ${list.length} 個管理員動作到公用庫？\n訓練紀錄不會公開；其他已登入會員的獨立動作庫不會改變。`))return;
 migrating=true;busy(true,'正在發布公用動作庫…');const g=generation;
 try{
  const meta=sdk.doc(sdk.db,'catalog','exercises'),current=await sdk.getDocFromServer(meta);
  if(current.data()?.initialized)throw Error('共用庫已建立，請重新整理');
  for(let i=0;i<list.length;i+=150){const batch=sdk.writeBatch(sdk.db);
   for(const e of list.slice(i,i+150))batch.set(sdk.doc(sdk.db,'catalog','exercises','items',key(e)),e);
   await batch.commit();
  }
  await sdk.setDoc(meta,{initialized:true,count:list.length,createdAt:new Date().toISOString()});
  if(g!==generation)return;
  catalogReady=true;shared=new Map(list.map(e=>[key(e),e]));recovery=new Map();publicLoaded=true;
  refresh();roleUI();publicListener();
  await migrateRecords(user,g);if(g===generation)recordListener();
  status(`已發布 ${list.length} 個公用動作，不會修改已建立的會員私人庫`);
 }catch(e){status('發布失敗：'+errorText(e));}
 finally{migrating=false;if(g===generation)busy(false);}
}
async function seedFromAdmin(){
 if(!isAdmin||!user)return;
 busy(true,'正在讀取管理員舊版資料…');
 try{const snap=await sdk.getDocsFromServer(sdk.collection(sdk.db,'users',user.uid,'exercises'));
  const rows=snap.docs.map(d=>({...d.data(),id:d.id}));
  if(rows.length)await publishCatalog(rows);
  else if(confirm('無舊版管理員資料，確定使用 Excel 初始動作建立公用庫嗎？'))await publishCatalog(window.StrengthApp.initialExercises());
 }catch(e){status('讀取管理員舊資料失敗：'+errorText(e));}
 finally{busy(false);}
}
function collectChanges(){
 if(!isReady())return;
 const live=new Map(window.StrengthApp.getExercises().map(e=>[key(e),e]));
 const source=isAdmin?merged(shared,pendingShared):merged(personal,pendingPersonal);
 const target=isAdmin?pendingShared:pendingPersonal;
 for(const [id,e] of live){const next=withoutHistory(e);if(!same(next,source.get(id)))target.set(id,next);}
 for(const id of source.keys())if(!live.has(id))target.set(id,null);
 for(const [id,e] of live){const log=ownHistory(e),old=effectiveRecord(id);
  if(!same(log,old))pendingRecords.set(id,log.length?log:null);
 }
 // Deleted actions' historical logs remain untouched in the private records collection.
}
function onLocalSave(){
 if(!user){status('訪客不能修改；請先登入');refresh();return false;}
 if(!isReady()){status('私人資料尚未載入，沒有儲存！');refresh();return false;}
 collectChanges();
 if(!pendingShared.size&&!pendingPersonal.size&&!pendingRecords.size)return true;
 status('已排入同步，等待 Firestore 確認…');
 clearTimeout(timer);timer=setTimeout(flush,180);return true;
}
async function flush(){
 clearTimeout(timer);if(writing||!sdk||!isReady())return false;
 if(!pendingShared.size&&!pendingPersonal.size&&!pendingRecords.size)return true;
 writing=true;lastError=null;const g=generation,uid=user.uid;
 const cat=new Map(pendingShared),priv=new Map(pendingPersonal),log=new Map(pendingRecords);
 status('正在寫入 Firestore…');
 try{
  if(cat.size&&!isAdmin)throw Error('非管理員不可修改公用庫');
  const ops=[...[...cat].map(([id,val])=>({type:'shared',id,val})),
   ...[...priv].map(([id,val])=>({type:'personal',id,val})),
   ...[...log].map(([id,val])=>({type:'records',id,val}))];
  for(let i=0;i<ops.length;i+=150){const batch=sdk.writeBatch(sdk.db);
   for(const op of ops.slice(i,i+150)){
    const ref=op.type==='shared'?sdk.doc(sdk.db,'catalog','exercises','items',op.id):
      sdk.doc(sdk.db,'users',uid,op.type==='personal'?'personalExercises':'records',op.id);
    if(op.val===null)batch.delete(ref);else batch.set(ref,op.type==='records'?{history:op.val}:op.val);
   }
   await batch.commit();if(g!==generation)return false;
  }
  for(const [id,v] of cat){if(v===null)shared.delete(id);else shared.set(id,v);if(same(pendingShared.get(id),v))pendingShared.delete(id);}
  for(const [id,v] of priv){if(v===null)personal.delete(id);else personal.set(id,v);if(same(pendingPersonal.get(id),v))pendingPersonal.delete(id);}
  for(const [id,v] of log){if(v===null)records.delete(id);else records.set(id,v);if(same(pendingRecords.get(id),v))pendingRecords.delete(id);}
  refresh();status(isAdmin?'Firestore 已確認：公用動作與私人訓練紀錄已儲存':'Firestore 已確認：獨立私人動作與紀錄已儲存');
  return !(pendingShared.size||pendingPersonal.size||pendingRecords.size);
 }catch(e){lastError=e;status('雲端儲存失敗（尚未確認）︰'+errorText(e)+'。請匯出 JSON 備份並勿登出。');return false;}
 finally{writing=false;if(!lastError&&(pendingShared.size||pendingPersonal.size||pendingRecords.size)&&g===generation){clearTimeout(timer);timer=setTimeout(flush,250);}}
}

// Explicit public snapshot operations. These write ONLY personalExercises and never records.
async function publicCatalogSnapshot(){
 const snap=await sdk.getDocsFromServer(sdk.collection(sdk.db,'catalog','exercises','items'));
 if(snap.empty)throw Error('公用動作庫目前沒有資料，為避免清空個人動作，已取消操作');
 return new Map(snap.docs.map(d=>[d.id,withoutHistory({...d.data(),id:d.id})]));
}
function memberOperationsAllowed(){
 if(!user||isAdmin||!isReady())throw Error('請以一般會員登入並等待私人資料同步完成');
}
async function writePersonalMutations(changes){
 memberOperationsAllowed();
 if(writing||pendingPersonal.size||pendingRecords.size||pendingShared.size){
  while(writing)await new Promise(r=>setTimeout(r,80));
  if(!await flush())throw Error('前一筆修改尚未同步，請先處理雲端同步狀態');
 }
 const uid=user.uid,g=generation;
 // Keep local catalogs unchanged until confirmed server-side commit.
 const operations=[...changes];
 for(let i=0;i<operations.length;i+=150){
  const batch=sdk.writeBatch(sdk.db);
  for(const [id,val] of operations.slice(i,i+150)){
   const ref=sdk.doc(sdk.db,'users',uid,'personalExercises',id);
   if(val===null)batch.delete(ref);else batch.set(ref,withoutHistory(val));
  }
  await batch.commit();
  if(g!==generation||user?.uid!==uid)throw Error('帳號已變更，請重新登入確認結果');
 }
 for(const [id,val] of operations){if(val===null)personal.delete(id);else personal.set(id,withoutHistory(val));}
 refresh();
 status(`Firestore 已確認更新 ${operations.length} 個私人動作，訓練紀錄未修改`);
 return {ok:true,updated:operations.length};
}
async function syncExerciseFromPublic(id,hint={}){
 try{
  memberOperationsAllowed();
  const targetId=String(id);
  // Match exact document ID first; old imported copies can have a different ID.
  let candidate=null;
  const snapshot=await sdk.getDocFromServer(sdk.doc(sdk.db,'catalog','exercises','items',targetId));
  if(snapshot.exists())candidate={...snapshot.data(),id:targetId};
  if(!candidate){
   const all=await publicCatalogSnapshot();
   const norm=v=>String(v||'').trim().replace(/\s+/g,'').toLocaleLowerCase();
   const name=norm(hint.name||personal.get(targetId)?.name);
   const large=norm(hint.large||personal.get(targetId)?.large);
   const detail=norm(hint.detail||personal.get(targetId)?.detail);
   let matches=[...all.values()].filter(e=>norm(e.name)===name&&norm(e.large)===large&&norm(e.detail)===detail);
   if(!matches.length)matches=[...all.values()].filter(e=>norm(e.name)===name);
   if(matches.length!==1)throw Error(matches.length?'公用動作庫有多個同名動作，無法自動判斷要同步哪一個':'公用動作庫找不到對應動作，可能已被管理員刪除或更名');
   candidate=matches[0];
  }
  // Keep the member's own ID so private records remain associated with this exercise.
  // The public document is copied as DATA ONLY; records live in /records, untouched.
  const updated={...candidate,id:targetId};
  const result=await writePersonalMutations([[targetId,updated]]);
  status('Firestore 已確認同步公用動作：'+(updated.name||targetId)+'；訓練紀錄未修改');
  return result;
 }catch(e){const message=errorText(e);status('同步單一動作失敗：'+message);return {ok:false,error:message};}
}
async function inspectPublicRestore(){
 try{memberOperationsAllowed();const pub=await publicCatalogSnapshot();const custom=[...personal.keys()].filter(id=>!pub.has(id));return {ok:true,publicCount:pub.size,personalCount:personal.size,customCount:custom.length};}
 catch(e){return {ok:false,error:errorText(e)}}
}
async function restorePersonalFromPublic({removeCustom=false}={}){
 try{memberOperationsAllowed();
  const pub=await publicCatalogSnapshot();
  const changes=new Map();
  for(const [id,e] of pub){if(!same(personal.get(id),e))changes.set(id,e);}
  if(removeCustom)for(const id of personal.keys())if(!pub.has(id))changes.set(id,null);
  if(!changes.size){status('私人動作已與公用動作一致，無須更新；紀錄不變');return {ok:true,updated:0};}
  return await writePersonalMutations(changes);
 }catch(e){const message=errorText(e);status('還原私人動作失敗：'+message);return {ok:false,error:message};}
}
window.CloudTraining={onLocalSave,flushNow:flush,syncExerciseFromPublic,inspectPublicRestore,restorePersonalFromPublic,
 get hasUser(){return !!user;},get isAdmin(){return isAdmin;},get configured(){return configured;},
 get ready(){return isReady();},get recovery(){return Boolean(user&&isAdmin&&!catalogReady&&recovery.size);}
};
if(!configured){status('Firebase 尚未設定');const link=$('#cloudSetup');if(link)link.hidden=false;}
else{
 document.body.classList.add('cloud-guest');
 try{
  const v='12.19.0';
  const [{initializeApp},{getAuth,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged},
   {getFirestore,doc,collection,getDocsFromServer,getDocFromServer,onSnapshot,writeBatch,setDoc}]=await Promise.all([
   import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
   import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
   import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`)
  ]);
  const app=initializeApp(cfg),auth=getAuth(app),db=getFirestore(app);
  sdk={db,auth,doc,collection,getDocsFromServer,getDocFromServer,onSnapshot,writeBatch,setDoc};
  login.onclick=async()=>{try{status('正在選擇 Google 帳號…');const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await signInWithPopup(auth,provider);}catch(e){status('登入失敗：'+errorText(e));}};
  logout.onclick=async()=>{logout.disabled=true;try{
   while(writing)await new Promise(r=>setTimeout(r,100));
   if(pendingShared.size||pendingPersonal.size||pendingRecords.size){if(!await flush())throw Error('尚有未完成寫入，請稍後重試');}
   await signOut(auth);
  }catch(e){status('登出失敗：'+errorText(e));}finally{logout.disabled=false;}};
  const publish=$('#publishCatalog');if(publish)publish.onclick=seedFromAdmin;
  onAuthStateChanged(auth,loadSession,e=>status('登入狀態異常：'+errorText(e)));
 }catch(e){status('Firebase SDK 載入失敗：'+errorText(e));}
}
