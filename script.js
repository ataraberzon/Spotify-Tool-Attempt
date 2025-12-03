/* =========================
   CONFIG - REPLACE CLIENT_ID
   ========================= */
const CLIENT_ID = 'd94ced667fed4edfb6afc6d52479aa5e'; // <<--- replace
const REDIRECT_URI = window.location.origin + '/';
const SCOPES = 'playlist-read-private playlist-read-collaborative user-read-private';

/* =========================
   PKCE + Auth Helpers
   ========================= */
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < length; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}
function base64UrlEncode(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function pkceChallengeFromVerifier(v) {
  const hashed = await sha256(v);
  return base64UrlEncode(hashed);
}
function qs(obj){ return Object.entries(obj).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&'); }

/* =========================
   App State
   ========================= */
let accessToken = null;
let refreshToken = null;
let codeVerifier = null;
let audio = new Audio();
let currentPlayingId = null;
let allTracks = [];
let nextFetch = null;
let playlistIdGlobal = null;
let isFetching = false;

/* =========================
   UI refs
   ========================= */
const playlistUrlInput = document.getElementById('playlistUrl');
const loadBtn = document.getElementById('loadBtn');
const listEl = document.getElementById('list');
const loaderEl = document.getElementById('loader');
const plistTitle = document.getElementById('plistTitle');
const plistOwner = document.getElementById('plistOwner');
const plistCount = document.getElementById('plistCount');
const plistCover = document.getElementById('plistCover');
const authStatus = document.getElementById('auth-status');
const signBtn = document.getElementById('signBtn');
const myPlaylistsBtn = document.getElementById('myPlaylistsBtn');
const pickArea = document.getElementById('pickArea');
const myLists = document.getElementById('myLists');

/* =========================
   Auth flow (PKCE)
   ========================= */
async function startAuth() {
  codeVerifier = generateRandomString(64);
  const challenge = await pkceChallengeFromVerifier(codeVerifier);
  sessionStorage.setItem('code_verifier', codeVerifier);
  const state = generateRandomString(12);
  sessionStorage.setItem('pkce_state', state);
  const params = {
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES
  };
  const authUrl = 'https://accounts.spotify.com/authorize?' + qs(params);
  window.location = authUrl;
}
async function handleRedirectCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) { console.error('Auth error', error); return; }
  if (!code) return;
  const savedState = sessionStorage.getItem('pkce_state');
  if (!savedState || savedState !== state) { console.error('Invalid state'); return; }
  const verifier = sessionStorage.getItem('code_verifier');
  if (!verifier) return;
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier
  };
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:qs(body)
  });
  const data = await resp.json();
  if (data.error) { console.error('Token error', data); return; }
  accessToken = data.access_token;
  sessionStorage.setItem('sp_access_token', accessToken);
  history.replaceState({}, document.title, REDIRECT_URI);
  updateAuthUI();
}

/* =========================
   Helpers
   ========================= */
function setStatus(msg){ authStatus.textContent = msg; }
function clearList(){
  listEl.innerHTML = '';
  allTracks=[];
  playlistIdGlobal = null;
  plistTitle.textContent='Playlist Title';
  plistOwner.textContent='';
  plistCount.textContent='0';
  plistCover.innerHTML='';
}
function extractPlaylistId(urlOrId){
  if(!urlOrId) return null;
  try{
    const u = new URL(urlOrId);
    const parts = u.pathname.split('/');
    const idx = parts.indexOf('playlist');
    if(idx>=0 && parts[idx+1]) return parts[idx+1];
  }catch(e){}
  if(urlOrId.match(/^[0-9A-Za-z_-]{22,}$/)) return urlOrId;
  return null;
}

/* =========================
   API Calls
   ========================= */
async function apiGet(url){
  const h = { 'Accept':'application/json' };
  if(accessToken) h['Authorization'] = 'Bearer ' + accessToken;
  const r = await fetch(url, { headers:h });
  if(r.status===401){
    sessionStorage.removeItem('sp_access_token');
    accessToken = null;
    updateAuthUI();
    throw new Error('Unauthorized - please sign in again');
  }
  return await r.json();
}

async function fetchPlaylistMetadata(playlistId){
  return await apiGet(`https://api.spotify.com/v1/playlists/${playlistId}`);
}

async function fetchPlaylistTracksPaged(playlistId, offset=0, limit=100){
  return await apiGet(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}&fields=items(track(id,name,artists,album(name,images),preview_url,uri)),total,next`
  );
}

async function fetchAllTracksAppend(playlistId){
  if(isFetching) return;
  isFetching = true;
  loaderEl.style.display='block';
  try{
    let offset = allTracks.length;
    const page = await fetchPlaylistTracksPaged(playlistId, offset, 100);
    if(!page.items) return;
    for(const it of page.items){
      if(!it.track) continue;
      allTracks.push(it.track);
      appendRow(it.track, allTracks.length-1);
    }
    plistCount.textContent = allTracks.length;
    if(page.next){
      nextFetch = () => fetchAllTracksAppend(playlistId);
    } else {
      nextFetch = null;
    }
  } catch(err){
    console.error(err);
    alert('Error fetching tracks: '+(err.message||err));
  } finally {
    isFetching = false;
    loaderEl.style.display='none';
  }
}

/* =========================
   Rendering rows
   ========================= */
function appendRow(track, index){
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.index = index;

  const art = document.createElement('div'); 
  art.className='art';
  const img = document.createElement('img');
  img.src = track.album?.images?.[0]?.url || '';
  img.alt = track.name;
  art.appendChild(img);

  const meta = document.createElement('div'); 
  meta.className='meta';
  const song = document.createElement('div'); 
  song.className='song'; 
  song.textContent = track.name;
  const artist = document.createElement('div'); 
  artist.className='artist'; 
  artist.textContent = track.artists.map(a=>a.name).join(', ');
  meta.appendChild(song); 
  meta.appendChild(artist);

  const ctrls = document.createElement('div'); 
  ctrls.className='controls';
  const playBtn = document.createElement('button'); 
  playBtn.className='playbtn'; 
  playBtn.title='Play preview';
  playBtn.innerHTML = '&#9658;';
  if(!track.preview_url){
    playBtn.disabled=true;
    playBtn.title='No preview available';
    playBtn.style.opacity=0.45;
  }
  ctrls.appendChild(playBtn);

  const timeNote = document.createElement('div'); 
  timeNote.className='small'; 
  timeNote.textContent = track.preview_url ? 'preview' : '—';
  ctrls.appendChild(timeNote);

  row.appendChild(art);
  row.appendChild(meta);
  row.appendChild(ctrls);
  listEl.appendChild(row);

  row.addEventListener('click', ()=> playTrackAtIndex(index, row, playBtn));
  playBtn.addEventListener('click', (e)=>{ e.stopPropagation(); playTrackAtIndex(index, row, playBtn); });
}

function setPlayingClass(rowEl, playing){
  const btn = rowEl.querySelector('.playbtn');
  if(!btn) return;
  if(playing) btn.classList.add('playing'), btn.innerHTML = '&#9208;';
  else btn.classList.remove('playing'), btn.innerHTML = '&#9658;';
}

async function playTrackAtIndex(index, rowEl){
  const t = allTracks[index];
  if(!t) return;
  if(!t.preview_url){
    alert('No preview available for this track.');
    return;
  }
  if(currentPlayingId === t.id){
    if(!audio.paused){
      audio.pause();
      setPlayingClass(rowEl,false);
      currentPlayingId = null;
      return;
    }
  }
  const oldRow = document.querySelector('.row.playing-row');
  if(oldRow){ oldRow.classList.remove('playing-row'); setPlayingClass(oldRow,false); }
  audio.pause();
  audio = new Audio(t.preview_url);
  audio.crossOrigin = "anonymous";
  audio.play().catch(err=>console.warn('play failed',err));
  currentPlayingId = t.id;
  rowEl.classList.add('playing-row');
  setPlayingClass(rowEl,true);
  audio.onended = ()=>{ rowEl.classList.remove('playing-row'); setPlayingClass(rowEl,false); currentPlayingId = null; };
  audio.onpause = ()=> setPlayingClass(rowEl,false);
}

/* =========================
   Infinite scroll
   ========================= */
let scrollObserver = null;
function setupScrollObserver(){
  if(scrollObserver) scrollObserver.disconnect();
  const sentinel = document.createElement('div');
  sentinel.id = 'scroll-sentinel';
  sentinel.style.padding = '20px';
  listEl.appendChild(sentinel);
  scrollObserver = new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(e.isIntersecting && nextFetch && !isFetching) nextFetch();
    });
  },{root:null,rootMargin:'200px'});
  scrollObserver.observe(sentinel);
}

/* =========================
   Load playlist
   ========================= */
loadBtn.addEventListener('click', async ()=>{
  const id = extractPlaylistId(playlistUrlInput.value.trim());
  if(!id){ alert('Paste a valid Spotify playlist URL or ID.'); return; }
  clearList();
  playlistIdGlobal = id;
  document.getElementById('playlistArea').style.display='block';
  pickArea.style.display='none';
  loaderEl.style.display='block';
  try{
    const meta = await fetchPlaylistMetadata(id);
    plistTitle.textContent = meta.name || 'Playlist';
    plistOwner.textContent = `by ${meta.owner?.display_name || meta.owner?.id || 'unknown' } · `;
    plistCount.textContent = meta.tracks?.total || '0';
    if(meta.images && meta.images[0])
      plistCover.innerHTML = `<img src="${meta.images[0].url}" style="width:100%;height:100%;object-fit:cover;border-radius:6px" />`;
    await fetchAllTracksAppend(id);
    setupScrollObserver();
  } catch(err){
    console.error(err); alert('Error loading playlist');
  } finally {
    loaderEl.style.display='none';
  }
});

/* =========================
   User playlists
   ========================= */
myPlaylistsBtn.addEventListener('click', async ()=>{
  if(!accessToken){ alert('Please sign in with Spotify to browse your playlists'); return; }
  pickArea.style.display='block';
  document.getElementById('playlistArea').style.display='none';
  myLists.innerHTML = 'Loading…';
  try{
    let items = [];
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    while(url){
      const data = await apiGet(url);
      items = items.concat(data.items || []);
      url = data.next;
    }
    myLists.innerHTML = '';
    items.forEach(p=>{
      const b = document.createElement('button');
      b.textContent = `${p.name} — ${p.tracks.total} tracks`;
      b.style.display='block';
      b.style.width='100%';
      b.style.margin='6px 0';
      b.addEventListener('click', ()=>{
        playlistUrlInput.value = p.id;
        loadBtn.click();
      });
      myLists.appendChild(b);
    });
  } catch(err){
    console.error(err);
    myLists.innerHTML = 'Failed to load playlists.';
  }
});

/* =========================
   Auth UI
   ========================= */
signBtn.addEventListener('click', ()=> startAuth());
function updateAuthUI(){
  const saved = sessionStorage.getItem('sp_access_token');
  accessToken = saved || accessToken;
  if(accessToken){
    setStatus('Signed in');
    signBtn.style.display='none';
    myPlaylistsBtn.style.display='inline-block';
  } else {
    setStatus('Not signed in');
    signBtn.style.display='inline-block';
    myPlaylistsBtn.style.display='none';
  }
}

/* =========================
   Init
   ========================= */
(async function init(){
  await handleRedirectCallback().catch(()=>{});
  const saved = sessionStorage.getItem('sp_access_token');
  if(saved) accessToken = saved;
  updateAuthUI();
})();

/* =========================
   Keyboard pause/play
   ========================= */
window.addEventListener('keydown', (e)=>{
  if(e.code === 'Space'){
    e.preventDefault();
    if(audio.paused) audio.play().catch(()=>{});
    else audio.pause();
  }
});
(async function init(){
  try {
    await handleRedirectCallback();
  } catch(e){ console.warn('Callback handling failed', e); }
  
  accessToken = sessionStorage.getItem('sp_access_token') || accessToken;
  updateAuthUI();

  if(!accessToken){
    console.log('Not signed in. Click "Sign in with Spotify"');
  }
})();
