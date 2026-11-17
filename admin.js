(()=>{
'use strict';
const $=id=>document.getElementById(id);
const cfg=window.RA_ADMIN_CONFIG||{};
const url=String(cfg.url||'').replace(/\/$/,'');
const key=String(cfg.publishableKey||'');
const email=String(cfg.adminEmail||'');
const username=String(cfg.adminUsername||'admin123');
const statuses=['Diterima','Ditinjau','Ditindaklanjuti','Selesai'];
const sessionKey='ruang-aman-admin-session:'+url;
let session=null;
let reports=[];
let selected='';
let authRevision=0;
let refreshPromise=null;
let loadingPromise=null;
let pendingDelete='';
let toastTimeout=null;
const fmt=value=>{
  if(!value)return '—';
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'—':date.toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'});
};
const configured=()=>url.startsWith('https://')&&key.length>15&&email.includes('@');
function feedback(id,message){const el=$(id);el.textContent=message||'';el.hidden=!message;}
function message(text){const toast=$('toast');toast.textContent=text;toast.hidden=false;clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>{toast.hidden=true;},4100);}
function loadStored(){
  try{
    const value=JSON.parse(localStorage.getItem(sessionKey)||'null');
    if(value&&typeof value.access_token==='string'&&typeof value.refresh_token==='string'&&typeof value.user_id==='string'&&Number.isFinite(value.expires_at))return value;
  }catch{}
  return null;
}
function persist(value){
  session=value;
  try{
    if(value)localStorage.setItem(sessionKey,JSON.stringify(value));
    else localStorage.removeItem(sessionKey);
  }catch{}
}
function sessionFromAuth(result){
  if(!result?.access_token||!result?.refresh_token)throw Error('Sesi tidak dapat dibuat.');
  const userId=result.user?.id||session?.user_id;
  if(!userId)throw Error('Identitas akun tidak ditemukan.');
  return {
    access_token:result.access_token,
    refresh_token:result.refresh_token,
    expires_at:Number(result.expires_at||Math.floor(Date.now()/1000)+Number(result.expires_in||3600)),
    user_id:userId
  };
}
function switchView(mode){
  if(mode==='startup' && window.RA_SKIP_BOOT)mode='login';
  $('startup-panel').hidden=mode!=='startup';
  $('login-panel').hidden=mode!=='login';
  $('dashboard').hidden=mode!=='dashboard';
  $('logout').hidden=mode!=='dashboard';
}
function clearPrivateData(msg=''){
  authRevision+=1;
  persist(null);
  reports=[];
  selected='';
  $('report-list').replaceChildren();
  $('detail').replaceChildren();
  $('password').value='';
  if($('delete-dialog').open)$('delete-dialog').close();
  switchView('login');
  feedback('login-error',msg);
}
function apiError(status,data){
  const err=new Error(data?.message||data?.msg||data?.error_description||data?.error||'Permintaan gagal.');
  err.status=status;
  return err;
}
async function fetchRaw(path,{method='GET',body,headers={},jwt,timeoutMs=15000}={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url+path,{
      method,signal:controller.signal,cache:'no-store',
      headers:{apikey:key,Accept:'application/json',...(jwt?{Authorization:'Bearer '+jwt}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok)throw apiError(response.status,result);
    return result;
  }catch(err){
    if(err.name==='AbortError')throw Error('Koneksi terlalu lama. Coba lagi.');
    if(err instanceof TypeError)throw Error('Layanan laporan tidak dapat dijangkau. Periksa koneksi internet.');
    throw err;
  }finally{clearTimeout(timer);}
}
function authInvalid(err){return err?.status===400||err?.status===401||err?.status===403;}
async function refreshSession(){
  if(refreshPromise)return refreshPromise;
  if(!session?.refresh_token)throw Error('Sesi masuk tidak ditemukan.');
  const before=session.refresh_token;
  const thisRevision=authRevision;
  const promise=(async()=>{
    try{
      const result=await fetchRaw('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:before}});
      if(thisRevision!==authRevision)throw Error('Sesi telah diganti.');
      persist(sessionFromAuth(result));
      return session.access_token;
    }catch(err){
      if(thisRevision===authRevision&&authInvalid(err))clearPrivateData('Sesi sudah tidak berlaku. Silakan masuk lagi.');
      throw err;
    }
  })();
  refreshPromise=promise;
  try{return await promise;}finally{if(refreshPromise===promise)refreshPromise=null;}
}
async function getToken(force=false){
  if(!session)throw Error('Silakan masuk sebagai pengelola.');
  if(force||session.expires_at-Date.now()/1000<90)return refreshSession();
  return session.access_token;
}
async function request(path,options={}){
  const firstToken=await getToken();
  try{return await fetchRaw(path,{...options,jwt:firstToken});}
  catch(err){
    if(err.status!==401)throw err;
    const newToken=await getToken(true);
    return fetchRaw(path,{...options,jwt:newToken});
  }
}
async function verifyAdmin(userId){
  const acl=await request('/rest/v1/admin_users?select=user_id,username&user_id=eq.'+encodeURIComponent(userId));
  if(!Array.isArray(acl)||acl.length!==1||acl[0].username!==username)throw Error('Akun ini tidak memiliki akses pengelola.');
}
function badge(status){const el=document.createElement('span');el.className='chip'+(status==='Selesai'?' done':'');el.textContent=status;return el;}
const row=(label,value)=>{const el=document.createElement('p');el.className='detail-meta';const bold=document.createElement('strong');bold.textContent=label+': ';el.append(bold,document.createTextNode(String(value||'—')));return el;};
function renderStats(){
  $('stat-total').textContent=reports.length;
  $('stat-new').textContent=reports.filter(x=>x.status==='Diterima').length;
  $('stat-review').textContent=reports.filter(x=>['Ditinjau','Ditindaklanjuti'].includes(x.status)).length;
  $('stat-done').textContent=reports.filter(x=>x.status==='Selesai').length;
}
function renderList(){
  const root=$('report-list');root.replaceChildren();
  const q=$('search').value.toLowerCase().trim(),filter=$('filter').value;
  const found=reports.filter(r=>(!filter||r.status===filter)&&[r.public_id,r.type,r.place].some(v=>String(v||'').toLowerCase().includes(q)));
  for(const r of found){
    const button=document.createElement('button');button.type='button';button.className='report-item'+(selected===r.public_id?' active':'');
    const top=document.createElement('div');top.className='report-top';
    const title=document.createElement('strong');title.textContent=r.public_id;
    top.append(title,badge(r.status));
    const details=document.createElement('small');details.textContent=`${r.type} • ${r.place||'Lokasi tidak disebut'} • ${fmt(r.created_at)}`;
    button.append(top,details);
    button.addEventListener('click',()=>{selected=r.public_id;renderList();renderDetail();});
    root.append(button);
  }
  $('list-message').textContent=found.length?`${found.length} laporan ditampilkan (maksimal 200 laporan terbaru).`:'Tidak ada laporan sesuai filter.';
}
function renderDetail(){
  const panel=$('detail'),r=reports.find(x=>x.public_id===selected);
  panel.replaceChildren();
  if(!r){
    const empty=document.createElement('div');empty.className='detail-empty';
    const heading=document.createElement('h2');heading.textContent='Pilih laporan';
    const hint=document.createElement('p');hint.textContent='Pilih salah satu laporan untuk melihat kronologi dan tindakan.';
    empty.append(heading,hint);panel.append(empty);return;
  }
  const eyebrow=document.createElement('span');eyebrow.className='detail-kicker';eyebrow.textContent='DETAIL PENGADUAN';
  const heading=document.createElement('h2');heading.textContent=r.public_id;
  const meta=document.createElement('div');
  meta.append(row('Pelapor sebagai',r.role),row('Jenis',r.type),row('Lokasi',r.place),row('Dibuat',fmt(r.created_at)),row('Terakhir diperbarui',fmt(r.updated_at)));
  const storyTitle=document.createElement('h3');storyTitle.textContent='Kronologi';
  const story=document.createElement('p');story.className='story';story.textContent=r.story;
  const form=document.createElement('form');form.className='detail-form';
  const statLabel=document.createElement('label');statLabel.textContent='Status penanganan';
  const select=document.createElement('select');
  for(const status of statuses){const option=document.createElement('option');option.value=status;option.textContent=status;select.append(option);}
  select.value=r.status;
  const notesLabel=document.createElement('label');notesLabel.textContent='Catatan internal petugas';
  const notes=document.createElement('textarea');notes.maxLength=2000;notes.value=r.admin_note||'';notes.placeholder='Tindakan, koordinasi guru BK, dan perkembangan penanganan...';
  const save=document.createElement('button');save.className='button primary';save.textContent='Simpan Perubahan';save.type='submit';
  const note=document.createElement('p');note.className='feedback';note.setAttribute('role','status');
  form.append(statLabel,select,notesLabel,notes,save,note);
  form.addEventListener('submit',async event=>{
    event.preventDefault();save.disabled=true;note.textContent='Menyimpan perubahan...';
    try{
      const result=await request('/rest/v1/reports?public_id=eq.'+encodeURIComponent(r.public_id)+'&select=public_id,role,type,place,story,status,admin_note,created_at,updated_at',{
        method:'PATCH',headers:{Prefer:'return=representation'},body:{status:select.value,admin_note:notes.value}
      });
      if(!Array.isArray(result)||result.length!==1)throw Error('Perubahan tidak diizinkan.');
      reports=reports.map(x=>x.public_id===r.public_id?result[0]:x);
      renderStats();renderList();note.textContent='Perubahan berhasil disimpan.';message('Status laporan berhasil diperbarui.');
    }catch(err){note.textContent=err.message;}finally{save.disabled=false;}
  });
  panel.append(eyebrow,heading,badge(r.status),meta,storyTitle,story,form);
  const historyTitle=document.createElement('h3');historyTitle.textContent='Tindakan laporan';historyTitle.className='danger-heading';
  const danger=document.createElement('div');danger.className='danger-zone';
  const copy=document.createElement('div');copy.className='danger-copy';
  const label=document.createElement('strong');label.textContent='Hapus laporan permanen';
  const sub=document.createElement('p');sub.textContent='Laporan dan riwayat statusnya akan dihapus dari database serta tidak dapat dicek lagi menggunakan ID.';
  copy.append(label,sub);
  const button=document.createElement('button');button.type='button';button.className='button danger';button.textContent='Hapus Laporan';
  button.addEventListener('click',()=>openDelete(r.public_id));
  danger.append(copy,button);panel.append(historyTitle,danger);
}
function openDelete(id){
  if(!reports.some(r=>r.public_id===id))return;
  pendingDelete=id;
  $('delete-id').textContent=id;
  $('delete-confirm-input').value='';
  $('delete-confirm-input').setAttribute('aria-label','Ketik ID laporan untuk konfirmasi');
  $('delete-submit').disabled=true;
  feedback('delete-error','');
  $('delete-dialog').showModal();
  $('delete-confirm-input').focus();
}
function closeDelete(){
  if($('delete-submit').dataset.busy==='1')return;
  if($('delete-dialog').open)$('delete-dialog').close();
  pendingDelete='';
}
async function doDelete(){
  const id=pendingDelete;
  if(!id||$('delete-confirm-input').value.trim()!==id)return;
  const button=$('delete-submit');button.disabled=true;button.dataset.busy='1';
  feedback('delete-error','Menghapus laporan...');
  try{
    const result=await request('/rest/v1/reports?public_id=eq.'+encodeURIComponent(id)+'&select=public_id',{
      method:'DELETE',headers:{Prefer:'return=representation'}
    });
    if(!Array.isArray(result)||result.length!==1)throw Error('Laporan tidak ditemukan atau tidak boleh dihapus. Jalankan SQL izin hapus admin.');
    reports=reports.filter(r=>r.public_id!==id);
    if(selected===id)selected='';
    pendingDelete='';
    $('delete-dialog').close();
    renderStats();renderList();renderDetail();
    message(`Laporan ${id} berhasil dihapus.`);
  }catch(err){feedback('delete-error',err.message||'Gagal menghapus laporan.');}
  finally{button.dataset.busy='0';button.disabled=$('delete-confirm-input').value.trim()!==pendingDelete;}
}
async function load(){
  if(loadingPromise)return loadingPromise;
  const expected=authRevision;
  const p=(async()=>{
    $('refresh').disabled=true;$('list-message').textContent='Memuat laporan...';
    try{
      const data=await request('/rest/v1/reports?select=public_id,role,type,place,story,status,admin_note,created_at,updated_at&order=created_at.desc&limit=200');
      if(expected!==authRevision)return;
      if(!Array.isArray(data))throw Error('Format laporan tidak sesuai.');
      reports=data;
      if(selected&&!reports.some(r=>r.public_id===selected))selected='';
      renderStats();renderList();renderDetail();
    }catch(err){
      if(expected!==authRevision)return;
      $('list-message').textContent=err.message||'Gagal memuat laporan.';
      if(authInvalid(err))clearPrivateData('Sesi berakhir. Silakan login kembali.');
    }finally{$('refresh').disabled=false;}
  })();
  loadingPromise=p;
  try{await p;}finally{if(loadingPromise===p)loadingPromise=null;}
}
async function activateSession(userId){
  await verifyAdmin(userId);
  switchView('dashboard');
  feedback('login-error','');
  $('password').value='';
  await load();
}
async function start(){
  if(!configured()){switchView('login');feedback('login-error','Layanan admin belum siap. Hubungi pengelola website.');return;}
  if(window.RA_SKIP_BOOT){switchView('login');return;}
  session=loadStored();
  if(!session){switchView('login');return;}
  switchView('startup');
  const expected=authRevision;
  try{
    await getToken();
    if(expected!==authRevision||window.RA_SKIP_BOOT)return;
    await activateSession(session.user_id);
  }catch(err){
    if(expected!==authRevision||window.RA_SKIP_BOOT)return;
    if(authInvalid(err)||/akses pengelola/i.test(err.message))clearPrivateData('Akses akun tidak berlaku. Silakan login kembali.');
    else{switchView('login');feedback('login-error','Tidak dapat memulihkan sesi sekarang. Periksa koneksi lalu muat ulang halaman.');}
  }
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();feedback('login-error','');
  if(!configured()){feedback('login-error','Layanan admin belum tersedia. Hubungi pengelola website.');return;}
  if($('username').value.trim()!==username){feedback('login-error','Username atau password salah.');return;}
  const button=$('login-btn');button.disabled=true;button.textContent='Memeriksa akun...';
  const loginRevision=++authRevision;
  try{
    const result=await fetchRaw('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password:$('password').value}});
    if(loginRevision!==authRevision)return;
    persist(sessionFromAuth(result));
    await activateSession(session.user_id);
  }catch(err){
    if(loginRevision===authRevision){clearPrivateData('Login gagal. Periksa username, password, atau izin admin.');}
  }finally{button.disabled=false;button.textContent='Masuk ke Dashboard ↗';}
});
$('logout').addEventListener('click',async()=>{
  const oldToken=session?.access_token||'';
  clearPrivateData('');
  if(oldToken){try{await fetchRaw('/auth/v1/logout',{method:'POST',jwt:oldToken,timeoutMs:5000});}catch{}}
  message('Berhasil keluar dari dashboard.');
});
$('search').addEventListener('input',renderList);
$('filter').addEventListener('change',renderList);
$('refresh').addEventListener('click',load);
$('delete-cancel').addEventListener('click',closeDelete);
$('delete-confirm-input').addEventListener('input',()=>{$('delete-submit').disabled=$('delete-confirm-input').value.trim()!==pendingDelete;});
$('delete-submit').addEventListener('click',doDelete);
$('delete-dialog').addEventListener('cancel',event=>{if($('delete-submit').dataset.busy==='1'){event.preventDefault();return;}pendingDelete='';});
$('delete-dialog').addEventListener('close',()=>{pendingDelete='';});
window.addEventListener('storage',event=>{
  if(event.key!==sessionKey)return;
  if(!event.newValue){clearPrivateData('Sesi telah keluar dari tab lain.');return;}
  if($('dashboard').hidden){authRevision+=1;start();}
});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&session&&!$('dashboard').hidden&&session.expires_at-Date.now()/1000<120){getToken().catch(()=>{});}
});
try{start();}catch(err){
  if(typeof window.RA_SHOW_LOGIN==='function')window.RA_SHOW_LOGIN('Gagal membuka halaman pengelola. Silakan masuk kembali.');
}
})();
