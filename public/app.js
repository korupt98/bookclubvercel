/* ── State ──────────────────────────────────────────────────────────────────── */
let authToken        = null;
let currentUser      = null;
let currentClubId    = null;
let adminClubId      = null;
let _editClubId      = null;    // context for edit-book modal
let allBooks         = [];
let allClubs         = [];
let allUsers         = [];
let clubMembers      = [];
let votingSession    = null;
let manageVotingSession = null;
let selectedVoteIds  = [];
let pickedBook       = null;
let adminPickedBook  = null;
let searchTimer      = null;
let adminSearchTimer = null;
let _memberSetup     = false;
let sortField        = 'added_at';
let sortDir          = 'desc';
let _expandedClubs   = new Set();

const _aState = {
  admin:  { books: [], members: [], filtered: [] },
  manage: { books: [], members: [], filtered: [] },
};

/* ── Boot ───────────────────────────────────────────────────────────────────── */
async function init() {
  // Show public home while loading
  el('public-home').classList.remove('hidden');
  el('login-page').classList.add('hidden');
  el('member-app').classList.add('hidden');
  el('admin-app').classList.add('hidden');

  // Load public clubs/books
  await loadPublicHome();

  // Fetch config and prep Google auth
  try {
    const config = await api('/api/config').catch(() => null);
    if (config?.googleClientId) {
      window._pendingGoogleClientId = config.googleClientId;
      if (window.google?.accounts?.id) initGoogleButton(config.googleClientId);
    }
  } catch {}

  // Check stored auth token
  authToken = localStorage.getItem('bc_token');
  if (authToken) {
    try { await fetchMe(); return; } catch { localStorage.removeItem('bc_token'); authToken = null; }
  }
  // Stay on public home
}

/* ── Google Auth ────────────────────────────────────────────────────────────── */
function onGSILoad() {
  if (window._pendingGoogleClientId) initGoogleButton(window._pendingGoogleClientId);
}

function initGoogleButton(clientId) {
  if (!window.google?.accounts?.id) return;
  google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleLogin, auto_select: false });
  const btn = el('google-signin-btn');
  if (btn) google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', text: 'signin_with_google', width: '360' });
}

async function handleGoogleLogin(response) {
  try {
    const data = await api('/api/auth/google', 'POST', { credential: response.credential });
    authToken   = data.token;
    currentUser = data.user;
    allClubs    = data.user.bookclubs || [];
    localStorage.setItem('bc_token', authToken);
    el('login-error').classList.add('hidden');
    await fetchMe();
  } catch (e) { showLoginError(e.message); }
}

/* ── Auth ───────────────────────────────────────────────────────────────────── */
function showLogin() {
  el('public-home').classList.add('hidden');
  el('login-page').classList.remove('hidden');
  el('member-app').classList.add('hidden');
  el('admin-app').classList.add('hidden');
  populateQuickClubs();
}

function populateQuickClubs() {
  const sel = el('quick-club-select');
  sel.innerHTML = '<option value="">— select club —</option>' +
    (window._publicClubs || []).map(c =>
      `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

async function fetchMe() {
  const me = await api('/api/auth/me');
  currentUser = me;
  allClubs = me.bookclubs || [];
  if (me.role === 'superadmin' && !sessionStorage.getItem('bc_member_view')) {
    showAdmin();
  } else {
    // Superadmin in member view: fetch all clubs (they may not be a member of any)
    if (me.role === 'superadmin') {
      allClubs = await api('/api/bookclubs').catch(() => allClubs);
    }
    showMember();
  }
}

el('public-signin-btn').addEventListener('click', showLogin);
el('login-back-btn').addEventListener('click', () => {
  el('login-page').classList.add('hidden');
  el('public-home').classList.remove('hidden');
});
el('login-btn').addEventListener('click', doLogin);
el('login-password').addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); });

el('quick-club-select').addEventListener('change', async () => {
  const clubId = parseInt(el('quick-club-select').value);
  el('quick-member-field').classList.add('hidden');
  el('quick-signin-btn').disabled = true;
  el('quick-member-select').innerHTML = '<option value="">— select name —</option>';
  if (!clubId) return;
  try {
    const members = await api(`/api/bookclubs/${clubId}/members/quick`);
    el('quick-member-select').innerHTML =
      '<option value="">— select name —</option>' +
      members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    el('quick-member-field').classList.remove('hidden');
  } catch {}
});

el('quick-member-select').addEventListener('change', () => {
  el('quick-signin-btn').disabled = !el('quick-member-select').value;
});

el('quick-signin-btn').addEventListener('click', doQuickLogin);

async function doLogin() {
  const email    = el('login-email').value.trim();
  const password = el('login-password').value;
  if (!email || !password) return showLoginError('Enter email and password');
  try {
    const data  = await api('/api/auth/login', 'POST', { email, password });
    authToken   = data.token;
    currentUser = data.user;
    allClubs    = data.user.bookclubs || [];
    localStorage.setItem('bc_token', authToken);
    el('login-error').classList.add('hidden');
    await fetchMe();
  } catch (e) { showLoginError(e.message); }
}

async function doQuickLogin() {
  const clubId = parseInt(el('quick-club-select').value);
  const userId = parseInt(el('quick-member-select').value);
  if (!clubId || !userId) return;
  try {
    const data  = await api('/api/auth/quick', 'POST', { user_id: userId, club_id: clubId });
    authToken   = data.token;
    currentUser = data.user;
    allClubs    = data.user.bookclubs || [];
    localStorage.setItem('bc_token', authToken);
    el('quick-error').classList.add('hidden');
    await fetchMe();
  } catch (e) {
    const p = el('quick-error'); p.textContent = e.message; p.classList.remove('hidden');
  }
}

function showLoginError(msg) {
  const p = el('login-error'); p.textContent = msg; p.classList.remove('hidden');
}

async function logout() {
  try { await api('/api/auth/logout', 'POST'); } catch {}
  authToken = null;
  localStorage.removeItem('bc_token');
  location.reload();
}
el('member-logout-btn').addEventListener('click', logout);
el('admin-logout-btn').addEventListener('click', logout);

el('switch-to-member-btn').addEventListener('click', async () => {
  sessionStorage.setItem('bc_member_view', '1');
  el('admin-app').classList.add('hidden');
  // Superadmin needs all clubs in member view
  if (isSuperAdmin() && (!allClubs.length || !allClubs[0].club_role)) {
    allClubs = await api('/api/bookclubs').catch(() => allClubs);
  }
  if (!_memberSetup) {
    showMember();
  } else {
    el('member-app').classList.remove('hidden');
    el('switch-to-admin-btn').classList.remove('hidden');
    if (currentClubId) await loadMemberClub();
    else if (allClubs.length) { currentClubId = allClubs[0].id; await loadMemberClub(); }
  }
});

el('switch-to-admin-btn').addEventListener('click', () => {
  sessionStorage.removeItem('bc_member_view');
  el('member-app').classList.add('hidden');
  el('admin-app').classList.remove('hidden');
});

/* ── Role helpers ───────────────────────────────────────────────────────────── */
function isSuperAdmin() { return currentUser?.role === 'superadmin'; }
function isClubAdmin(clubId) {
  if (isSuperAdmin()) return true;
  const club = allClubs.find(c => c.id === clubId);
  return club?.club_role === 'admin';
}

/* ── Public Home ────────────────────────────────────────────────────────────── */
async function loadPublicHome() {
  try {
    const clubs = await api('/api/public/clubs');
    window._publicClubs = clubs;
    _expandedClubs = new Set();
    renderPublicGrid();
  } catch {
    el('public-clubs-grid').innerHTML = `<p class="dim text-center">Unable to load clubs.</p>`;
  }
}

function renderPublicGrid() {
  const grid = el('public-clubs-grid');
  if (!window._publicClubs?.length) {
    grid.innerHTML = `<p class="dim text-center">No book clubs yet.</p>`;
    return;
  }
  grid.innerHTML = window._publicClubs.map(c =>
    renderPublicClubCard(c, _expandedClubs.has(c.id))
  ).join('');
}

function renderPublicClubCard(c, expanded) {
  const LIMIT   = 5;
  const visible = expanded ? c.books : c.books.slice(0, LIMIT);
  const hasMore = c.books.length > LIMIT;

  const bookItems = visible.length
    ? visible.map(b => {
        const cover = b.cover_url
          ? `<img src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
          : `<div class="pub-book-ph">&#128214;</div>`;
        const badge = b.selected
          ? `<span class="badge badge-selected">&#10003;</span>`
          : !b.active_for_voting ? `<span class="badge badge-removed">Removed</span>` : '';
        const meta = [b.author, b.page_count ? `${Number(b.page_count).toLocaleString()} pages` : null]
          .filter(Boolean).join(' · ');
        return `<div class="public-book-item">
          ${cover}
          <div class="pub-book-info">
            <div class="pub-book-title">${esc(b.title)}</div>
            <div class="pub-book-author">${esc(meta)}</div>
            ${badge ? `<div>${badge}</div>` : ''}
          </div>
        </div>`;
      }).join('')
    : `<p class="dim" style="font-size:.85rem;padding:.5rem 0">No books yet.</p>`;

  const expandBtn = !expanded && hasMore
    ? `<button class="btn btn-ghost btn-sm pub-expand-btn" onclick="expandPublicClub(${c.id})">View all ${c.books.length} books →</button>`
    : expanded && c.books.length > LIMIT
      ? `<button class="btn btn-ghost btn-sm pub-expand-btn" onclick="collapsePublicClub(${c.id})">Show less ↑</button>`
      : '';

  return `<div class="public-club-card">
    <h3>${esc(c.name)}</h3>
    ${c.description ? `<p class="dim" style="font-size:.85rem;margin-bottom:.5rem">${esc(c.description)}</p>` : ''}
    <p class="pub-book-count dim">${c.books.length} book${c.books.length !== 1 ? 's' : ''}</p>
    <div class="public-books-list">${bookItems}</div>
    ${expandBtn}
  </div>`;
}

function expandPublicClub(clubId)   { _expandedClubs.add(clubId);    renderPublicGrid(); }
function collapsePublicClub(clubId) { _expandedClubs.delete(clubId); renderPublicGrid(); }

/* ══════════════════════════════════════════════════════════════════════════════
   MEMBER APP
══════════════════════════════════════════════════════════════════════════════ */
function showMember() {
  el('public-home').classList.add('hidden');
  el('login-page').classList.add('hidden');
  el('admin-app').classList.add('hidden');
  el('member-app').classList.remove('hidden');
  el('member-welcome').textContent = `Welcome, ${currentUser.name}`;

  // Show Manage tab for club admins and superadmins
  const hasAdminClub = isSuperAdmin() || allClubs.some(c => c.club_role === 'admin');
  el('manage-tab-btn').classList.toggle('hidden', !hasAdminClub);

  // Show Admin View button only for superadmins
  el('switch-to-admin-btn').classList.toggle('hidden', !isSuperAdmin());

  if (!_memberSetup) {
    _memberSetup = true;
    setupMemberTabs();
    setupMemberListeners();
  }
  setupMemberClubSwitcher(); // refresh club list each time (safe: uses onchange)
  if (allClubs.length) {
    currentClubId = allClubs[0].id;
    loadMemberClub();
  }
}

function setupMemberClubSwitcher() {
  if (allClubs.length <= 1) return;
  const wrap = el('club-switcher-wrap');
  const sel  = el('club-switcher');
  wrap.classList.remove('hidden');
  sel.innerHTML = allClubs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.onchange = () => { currentClubId = parseInt(sel.value); loadMemberClub(); };
}

function setupMemberTabs() {
  qsa('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('[data-tab]').forEach(b => b.classList.remove('active'));
      qsa('#member-app .tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      el(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'vote')   refreshVoteTab();
      if (btn.dataset.tab === 'manage') loadManageTab();
    });
  });
}

function setupMemberListeners() {
  el('show-inactive').addEventListener('change', renderBooksTable);
  el('book-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = el('book-search').value.trim();
    if (q.length < 2) { hideDropdown('search-dropdown'); return; }
    searchTimer = setTimeout(() => doSearch(q, 'search-dropdown', idx => pickBook(idx)), 420);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.autocomplete-wrap')) {
      hideDropdown('search-dropdown');
      hideDropdown('admin-search-dropdown');
    }
  });
  el('clear-preview').addEventListener('click', clearPick);
  el('add-book-btn').addEventListener('click', addBook);
  el('submit-vote-btn').addEventListener('click', submitVote);
  el('detail-close-btn').addEventListener('click', () => closeModal('details-modal'));

  // Manage tab
  el('manage-create-user-btn').addEventListener('click', createMemberFromManage);
  el('manage-create-session-btn').addEventListener('click', manageCreateSession);
  el('manage-close-session-btn').addEventListener('click', manageCloseSession);
  el('manage-analytics-run-btn').addEventListener('click', loadManageAnalytics);
  el('manage-analytics-from').addEventListener('change', () => applyAnalyticsFilters('manage'));
  el('manage-analytics-to').addEventListener('change', () => applyAnalyticsFilters('manage'));
  el('manage-analytics-member').addEventListener('change', () => applyAnalyticsFilters('manage'));

  // Member edit modal
  el('member-edit-save-btn').addEventListener('click', saveMemberEdit);
  el('member-edit-cancel-btn').addEventListener('click', () => closeModal('member-edit-modal'));

  // Filter controls
  el('book-filter-text').addEventListener('input', renderBooksTable);
  el('book-filter-genre').addEventListener('change', renderBooksTable);

  // Sortable column headers (thead is static HTML, safe to wire once)
  document.querySelectorAll('#books-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const f = th.dataset.sort;
      if (sortField === f) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortField = f; sortDir = f === 'added_at' ? 'desc' : 'asc'; }
      renderBooksTable();
    });
  });
}

async function loadMemberClub() {
  const club = allClubs.find(c => c.id === currentClubId);
  if (club) el('member-club-name').textContent = club.name;
  el('books-loading').classList.remove('hidden');
  el('table-wrap').classList.add('hidden');
  try {
    allBooks = await api(`/api/bookclubs/${currentClubId}/books`);
    populateGenreFilter();
    renderBooksTable();
  } finally { el('books-loading').classList.add('hidden'); }
  await refreshVoteTab();
}

function populateGenreFilter() {
  const genres = [...new Set(
    allBooks.map(b => b.genre?.split(',')[0]?.trim()).filter(Boolean)
  )].sort();
  const cur = el('book-filter-genre').value;
  el('book-filter-genre').innerHTML =
    '<option value="">All genres</option>' +
    genres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  if (cur) el('book-filter-genre').value = cur;
}

/* ── Book List (member) ──────────────────────────────── */
function renderBooksTable() {
  const showInactive = el('show-inactive').checked;
  const q     = (el('book-filter-text')?.value || '').trim().toLowerCase();
  const genre = el('book-filter-genre')?.value  || '';

  let books = showInactive ? allBooks : allBooks.filter(b => b.active_for_voting);
  if (q)     books = books.filter(b =>
    b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q));
  if (genre) books = books.filter(b =>
    b.genre?.split(',')[0]?.trim().toLowerCase() === genre.toLowerCase());

  // client-side sort
  books = [...books].sort((a, b) => {
    let va = a[sortField], vb = b[sortField];
    if (sortField === 'added_at') {
      va = va ? new Date(va).getTime() : 0;
      vb = vb ? new Date(vb).getTime() : 0;
    } else if (sortField === 'page_count') {
      va = Number(va) || 0; vb = Number(vb) || 0;
    } else {
      va = (va || '').toLowerCase(); vb = (vb || '').toLowerCase();
    }
    return sortDir === 'asc' ? (va < vb ? -1 : va > vb ? 1 : 0)
                             : (va > vb ? -1 : va < vb ? 1 : 0);
  });

  // update sort header indicators
  document.querySelectorAll('#books-table th[data-sort]').forEach(th => {
    th.classList.remove('th-sort-asc', 'th-sort-desc');
    if (th.dataset.sort === sortField)
      th.classList.add(sortDir === 'asc' ? 'th-sort-asc' : 'th-sort-desc');
  });

  const tbody = el('books-tbody');
  const wrap  = el('table-wrap');
  const empty = el('no-books');

  if (!books.length) { wrap.classList.add('hidden'); empty.classList.remove('hidden'); return; }
  wrap.classList.remove('hidden'); empty.classList.add('hidden');

  const canAdmin = isClubAdmin(currentClubId);
  tbody.innerHTML = books.map(b => {
    const isOwner = b.added_by_user_id === currentUser.id;
    const cover = b.cover_url
      ? `<img class="thumb" src="${b.cover_url}" alt="" onerror="this.outerHTML='<div class=thumb-ph>&#128214;</div>'">`
      : `<div class="thumb-ph">&#128214;</div>`;
    let badge;
    if (!b.active_for_voting) badge = `<span class="badge badge-removed">Removed</span>`;
    else if (b.selected)      badge = `<span class="badge badge-selected">&#10003; Selected</span>`;
    else                      badge = `<span class="badge badge-active">Active</span>`;
    const actions = [`<button class="btn btn-ghost btn-xs" onclick="showBookDetails(${b.id})">Details</button>`];
    if (canAdmin) {
      actions.push(`<button class="btn btn-ghost btn-xs" onclick="memberOpenEditBook(${b.id})">Edit</button>`);
    } else if (isOwner) {
      actions.push(`<button class="btn btn-ghost btn-xs" onclick="memberOpenOwnEdit(${b.id})">Edit</button>`);
    }
    if (isOwner || canAdmin) actions.push(`<button class="btn btn-ghost btn-xs" onclick="memberToggleVoting(${b.id})">${b.active_for_voting ? 'Remove' : 'Restore'}</button>`);
    return `<tr class="${!b.active_for_voting ? 'inactive' : ''}">
      <td>${cover}</td>
      <td><strong>${esc(b.title)}</strong></td>
      <td>${esc(b.author || '—')}</td>
      <td>${esc(b.genre  || '—')}</td>
      <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
      <td>${esc(b.added_by_name || '—')}</td>
      <td>${fmtDate(b.submitted_at || b.added_at)}</td>
      <td>${badge}</td>
      <td>${b.selected_at ? fmtDate(b.selected_at) : '—'}</td>
      <td><div class="action-group">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
}

async function memberToggleVoting(id) {
  try {
    const updated = await api(`/api/bookclubs/${currentClubId}/books/${id}/toggle-voting`, 'PATCH', {});
    const idx = allBooks.findIndex(b => b.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    renderBooksTable();
  } catch (e) { alert(e.message); }
}

async function memberOpenEditBook(id) {
  try { clubMembers = await api(`/api/bookclubs/${currentClubId}/members`); } catch {}
  _editClubId = currentClubId;
  openEditBook(id);
}

function memberOpenOwnEdit(id) {
  const b = allBooks.find(x => x.id === id);
  if (!b) return;
  el('member-edit-book-id').value    = b.id;
  el('member-edit-title').value      = b.title;
  el('member-edit-author').value     = b.author || '';
  el('member-edit-page-count').value = b.page_count || '';
  el('member-edit-desc').value       = b.description || '';
  el('member-edit-msg').classList.add('hidden');
  openModal('member-edit-modal');
}

async function saveMemberEdit() {
  const id = parseInt(el('member-edit-book-id').value);
  try {
    const updated = await api(`/api/bookclubs/${currentClubId}/books/${id}`, 'PATCH', {
      title:       el('member-edit-title').value.trim(),
      author:      el('member-edit-author').value.trim() || null,
      page_count:  parseInt(el('member-edit-page-count').value) || null,
      description: el('member-edit-desc').value.trim() || null,
    });
    const idx = allBooks.findIndex(x => x.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    renderBooksTable();
    closeModal('member-edit-modal');
  } catch (e) { showMsg('member-edit-msg', e.message, 'error'); }
}

/* ── Add Book (member) ───────────────────────────────── */
async function doSearch(q, dropdownId, onSelect) {
  const dd = el(dropdownId);
  dd.innerHTML = `<div class="drop-msg">Searching…</div>`;
  dd.classList.remove('hidden');
  try {
    const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
    window._searchResults = results;
    if (!results.length) { dd.innerHTML = `<div class="drop-msg">No results. Enter details manually.</div>`; return; }
    dd.innerHTML = results.map((b, i) => {
      const img = b.cover_url
        ? `<img src="${b.cover_url}" alt="" onerror="this.outerHTML='<div class=drop-thumb-ph>&#128214;</div>'">`
        : `<div class="drop-thumb-ph">&#128214;</div>`;
      return `<div class="drop-item" onclick="(${onSelect.toString()})(${i})">
        ${img}<div><div class="drop-title">${esc(b.title)}</div>
        <div class="drop-meta">${esc(b.author)}${b.page_count ? ` · ${b.page_count} pages` : ''}${b.genre ? ` · ${b.genre.split(',')[0]}` : ''}</div></div>
      </div>`;
    }).join('');
  } catch { dd.innerHTML = `<div class="drop-msg">Search failed. Try again.</div>`; }
}

async function pickBook(i) {
  pickedBook = window._searchResults[i];
  hideDropdown('search-dropdown');
  el('book-search').value = '';
  el('book-title').value  = pickedBook.title;
  el('book-author').value = pickedBook.author;
  el('preview-title').textContent  = pickedBook.title;
  el('preview-author').textContent = pickedBook.author;
  el('preview-pages').textContent  = pickedBook.page_count ? `${pickedBook.page_count} pages` : '';
  el('preview-genre').textContent  = pickedBook.genre ? `Genre: ${pickedBook.genre}` : '';
  el('preview-desc').textContent   = 'Loading description…';
  const img = el('preview-img');
  img.src = pickedBook.cover_url || ''; img.style.display = pickedBook.cover_url ? 'block' : 'none';
  el('book-preview').classList.remove('hidden');
  if (pickedBook.open_library_id) {
    try {
      const info = await api(`/api/book-info?key=${encodeURIComponent(pickedBook.open_library_id)}`);
      pickedBook.description = info.description || null;
      if (info.genre && !pickedBook.genre) pickedBook.genre = info.genre;
      el('preview-desc').textContent  = info.description || '';
      el('preview-genre').textContent = pickedBook.genre ? `Genre: ${pickedBook.genre}` : '';
    } catch { el('preview-desc').textContent = ''; }
  } else { el('preview-desc').textContent = ''; }
}

function clearPick() {
  pickedBook = null;
  el('book-title').value = ''; el('book-author').value = ''; el('book-search').value = '';
  el('book-preview').classList.add('hidden');
}

async function addBook() {
  const title  = el('book-title').value.trim();
  const author = el('book-author').value.trim();
  if (!title) return showAddMsg('Please enter a book title.', 'error');
  try {
    const book = await api(`/api/bookclubs/${currentClubId}/books`, 'POST', {
      title, author: author || null,
      cover_url:       pickedBook?.cover_url       || null,
      open_library_id: pickedBook?.open_library_id || null,
      page_count:      pickedBook?.page_count      || null,
      description:     pickedBook?.description     || null,
      genre:           pickedBook?.genre           || null,
    });
    showAddMsg('Book added!', 'success');
    clearPick();
    allBooks.unshift(book);
    renderBooksTable();
  } catch (e) { showAddMsg(e.message, 'error'); }
}

function showAddMsg(text, type) {
  const p = el('add-result');
  p.textContent = text; p.className = `msg msg-${type}`; p.classList.remove('hidden');
  setTimeout(() => p.classList.add('hidden'), 5000);
}

/* ── Voting (member) ─────────────────────────────────── */
async function refreshVoteTab() {
  if (!currentClubId) return;
  try { votingSession = await api(`/api/bookclubs/${currentClubId}/voting/session`); }
  catch { votingSession = null; }
  await renderVoteTab();
}

async function renderVoteTab() {
  ['vote-no-session','vote-closed-notice','vote-already-voted','vote-area','results-area']
    .forEach(id => el(id).classList.add('hidden'));
  if (!votingSession) { el('vote-no-session').classList.remove('hidden'); return; }
  if (votingSession.is_closed) {
    el('vote-closed-notice').classList.remove('hidden');
    await showPublicResults();
    el('results-area').classList.remove('hidden');
    return;
  }
  const { has_voted } = await api(`/api/bookclubs/${currentClubId}/voting/check-voted`);
  if (has_voted) { el('vote-already-voted').classList.remove('hidden'); return; }
  selectedVoteIds = [];
  el('selected-count').textContent = '0';
  el('submit-vote-btn').disabled = true;
  el('vote-msg').classList.add('hidden');
  renderVoteGrid();
  el('vote-area').classList.remove('hidden');
}

function renderVoteGrid() {
  const active = allBooks.filter(b => b.active_for_voting && !b.selected);
  const grid = el('vote-grid');
  if (!active.length) { grid.innerHTML = `<p class="dim">No books available for voting.</p>`; return; }
  grid.innerHTML = active.map(b => {
    const img = b.cover_url
      ? `<img src="${b.cover_url}" alt="" onerror="this.outerHTML='<div class=vc-ph>&#128214;</div>'">`
      : `<div class="vc-ph">&#128214;</div>`;
    return `<div class="vote-card" data-id="${b.id}" onclick="toggleVoteCard(${b.id})">
      ${img}<div class="vc-title">${esc(b.title)}</div>
      <div class="vc-author">${esc(b.author || '')}</div>
      ${b.page_count ? `<div class="vc-pages">${Number(b.page_count).toLocaleString()} pages</div>` : ''}
      <div class="vc-check">&#10003;</div>
    </div>`;
  }).join('');
}

function toggleVoteCard(id) {
  const card = document.querySelector(`.vote-card[data-id="${id}"]`);
  if (selectedVoteIds.includes(id)) {
    selectedVoteIds = selectedVoteIds.filter(x => x !== id);
    card.classList.remove('chosen');
  } else if (selectedVoteIds.length < 2) {
    selectedVoteIds.push(id); card.classList.add('chosen');
  }
  qsa('.vote-card').forEach(c => {
    c.classList.toggle('locked', !selectedVoteIds.includes(+c.dataset.id) && selectedVoteIds.length >= 2);
  });
  el('selected-count').textContent = selectedVoteIds.length;
  el('submit-vote-btn').disabled = selectedVoteIds.length !== 2;
}

async function submitVote() {
  if (selectedVoteIds.length !== 2) return;
  try {
    await api(`/api/bookclubs/${currentClubId}/voting/vote`, 'POST', { book_ids: selectedVoteIds });
    el('vote-area').classList.add('hidden');
    el('vote-already-voted').classList.remove('hidden');
  } catch (e) {
    const p = el('vote-msg'); p.textContent = e.message; p.className = 'msg msg-error'; p.classList.remove('hidden');
  }
}

async function showPublicResults() {
  if (!votingSession) return;
  try {
    const data = await api(`/api/bookclubs/${currentClubId}/voting/results/${votingSession.id}`);
    renderResults(data, el('results-list'), el('results-footer'));
  } catch {}
}

/* ── Manage tab (club admins) ────────────────────────── */
async function loadManageTab() {
  if (!currentClubId) return;
  const club = allClubs.find(c => c.id === currentClubId);
  el('manage-club-label').textContent = club ? `— ${club.name}` : '';
  try {
    clubMembers = await api(`/api/bookclubs/${currentClubId}/members`);
    renderManageMembers();
  } catch (e) { console.error(e); }
  await loadManageVoting();
  await loadManageAnalytics();
}

function renderManageMembers() {
  const list = el('manage-members-list');
  if (!clubMembers.length) { list.innerHTML = `<p class="dim">No members yet.</p>`; return; }
  list.innerHTML = clubMembers.map(u => {
    const roleBadge = u.club_role === 'admin'
      ? `<span class="role-badge role-badge-admin">Club Admin</span>`
      : `<span class="role-badge">Member</span>`;
    const toggleLabel = u.club_role === 'admin' ? 'Make Member' : 'Make Admin';
    return `<div class="member-row">
      <div class="member-info">
        <strong>${esc(u.name)}</strong>
        <span>${esc(u.email)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
        ${roleBadge}
        <div class="action-group">
          <button class="btn btn-ghost btn-xs" onclick="setMemberClubRole(${u.id},'${u.club_role === 'admin' ? 'member' : 'admin'}')">${toggleLabel}</button>
          <button class="btn btn-danger btn-xs" onclick="removeMemberFromManage(${u.id})">Remove</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function setMemberClubRole(userId, role) {
  try {
    await api(`/api/bookclubs/${currentClubId}/members/${userId}/role`, 'PATCH', { role });
    await loadManageTab();
  } catch (e) { alert(e.message); }
}

async function removeMemberFromManage(userId) {
  if (!confirm('Remove this member from the club?')) return;
  try {
    await api(`/api/bookclubs/${currentClubId}/members/${userId}`, 'DELETE');
    await loadManageTab();
  } catch (e) { alert(e.message); }
}

async function createMemberFromManage() {
  const name  = el('manage-user-name').value.trim();
  const email = el('manage-user-email').value.trim();
  if (!name || !email) return showMsg('manage-create-user-msg', 'Name and email required', 'error');
  try {
    const data = await api('/api/users', 'POST', { name, email, bookclub_ids: [currentClubId] });
    el('manage-user-name').value = ''; el('manage-user-email').value = '';
    showMsg('manage-create-user-msg', 'User created!', 'success');
    if (data.temp_password) {
      el('pwd-modal-email').textContent = email;
      el('pwd-modal-value').textContent  = data.temp_password;
      openModal('password-modal');
    }
    await loadManageTab();
  } catch (e) { showMsg('manage-create-user-msg', e.message, 'error'); }
}

async function loadManageVoting() {
  try { manageVotingSession = await api(`/api/bookclubs/${currentClubId}/voting/session`); }
  catch { manageVotingSession = null; }
  renderManageVotingPanel();
  if (manageVotingSession) await loadManageResults();
}

function renderManageVotingPanel() {
  const statusBox = el('manage-session-status');
  const createBtn = el('manage-create-session-btn');
  const closeBtn  = el('manage-close-session-btn');
  const resultsCard = el('manage-results-card');
  if (!manageVotingSession) {
    statusBox.style.cssText = 'background:#fee2e2;color:#991b1b';
    statusBox.textContent   = 'No active voting session.';
    createBtn.classList.remove('hidden'); closeBtn.classList.add('hidden');
    resultsCard.classList.add('hidden');
  } else if (!manageVotingSession.is_closed) {
    statusBox.style.cssText = 'background:#dcfce7;color:#166534';
    statusBox.textContent   = `Voting open — started ${fmtDate(manageVotingSession.created_at)}`;
    createBtn.classList.add('hidden'); closeBtn.classList.remove('hidden');
    resultsCard.classList.remove('hidden');
  } else {
    statusBox.style.cssText = 'background:#dbeafe;color:#1e40af';
    statusBox.textContent   = `Voting closed on ${fmtDate(manageVotingSession.closed_at)}`;
    createBtn.classList.remove('hidden'); closeBtn.classList.add('hidden');
    resultsCard.classList.remove('hidden');
  }
}

async function loadManageResults() {
  if (!manageVotingSession) return;
  try {
    const data = await api(`/api/bookclubs/${currentClubId}/voting/results/${manageVotingSession.id}`);
    renderResults(data, el('manage-results-list'), el('manage-results-footer'), el('manage-voter-status'));
  } catch {}
}

async function manageCreateSession() {
  try {
    manageVotingSession = await api(`/api/bookclubs/${currentClubId}/voting/session`, 'POST');
    renderManageVotingPanel();
  } catch (e) { alert(e.message); }
}

async function manageCloseSession() {
  if (!manageVotingSession || !confirm('Close voting and reveal results to all members?')) return;
  try {
    manageVotingSession = await api(`/api/bookclubs/${currentClubId}/voting/session/${manageVotingSession.id}/close`, 'PATCH');
    renderManageVotingPanel();
    await loadManageResults();
  } catch (e) { alert(e.message); }
}

/* ── Book Details Modal ──────────────────────────────── */
function showBookDetailsForBook(b) {
  if (!b) return;
  el('detail-title').textContent  = b.title;
  el('detail-author').textContent = b.author || 'Unknown Author';
  el('detail-pages').textContent  = b.page_count ? `${Number(b.page_count).toLocaleString()} pages` : '';
  el('detail-genre').textContent  = b.genre ? `Genre: ${b.genre}` : '';
  el('detail-desc').textContent   = b.description || '';
  const cover = el('detail-cover'), ph = el('detail-cover-ph');
  if (b.cover_url) { cover.src = b.cover_url; cover.style.display = 'block'; ph.style.display = 'none'; }
  else             { cover.style.display = 'none'; ph.style.display = 'flex'; }
  const q = encodeURIComponent(`${b.title} ${b.author || ''}`);
  const olLink = el('detail-ol-link');
  if (b.open_library_id) { olLink.href = `https://openlibrary.org${b.open_library_id}`; olLink.style.display = 'inline-flex'; }
  else { olLink.style.display = 'none'; }
  el('detail-amz-link').href = `https://www.amazon.com/s?k=${q}&i=stripbooks`;
  el('detail-gr-link').href  = `https://www.goodreads.com/search?q=${q}`;
  openModal('details-modal');
}

function showBookDetails(bookId) {
  showBookDetailsForBook(allBooks.find(x => x.id === bookId));
}

function showDrilldownBookDetails(bookId, ctx) {
  showBookDetailsForBook(_aState[ctx].books.find(x => x.id === bookId));
}

/* ══════════════════════════════════════════════════════════════════════════════
   ADMIN APP (Superadmin)
══════════════════════════════════════════════════════════════════════════════ */
function showAdmin() {
  sessionStorage.removeItem('bc_member_view');
  el('public-home').classList.add('hidden');
  el('login-page').classList.add('hidden');
  el('member-app').classList.add('hidden');
  el('admin-app').classList.remove('hidden');
  setupAdminTabs();
  setupAdminListeners();
  populateAdminClubSelect();
  loadAdminClubs();
  loadAllUsers();
}

function setupAdminTabs() {
  qsa('[data-admin-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('[data-admin-tab]').forEach(b => b.classList.remove('active'));
      qsa('#admin-app .tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      el(`admin-tab-${btn.dataset.adminTab}`).classList.add('active');
      const tab = btn.dataset.adminTab;
      if (tab === 'members')   loadAdminMembers();
      if (tab === 'books')     loadAdminBooks();
      if (tab === 'voting')    loadAdminVoting();
      if (tab === 'analytics') loadAnalytics();
      if (tab === 'users')     loadAllUsers();
    });
  });
}

function populateAdminClubSelect() {
  const sel = el('admin-club-select');
  sel.innerHTML = allClubs.length
    ? allClubs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : `<option value="">No clubs yet</option>`;
  if (allClubs.length) adminClubId = allClubs[0].id;
  sel.onchange = () => {
    adminClubId = parseInt(sel.value);
    const active = document.querySelector('[data-admin-tab].active');
    if (active) active.click();
  };
}

function setupAdminListeners() {
  el('show-create-club-btn').addEventListener('click', () => el('create-club-form').classList.toggle('hidden'));
  el('cancel-create-club-btn').addEventListener('click', () => el('create-club-form').classList.add('hidden'));
  el('create-club-btn').addEventListener('click', createClub);
  el('create-user-btn').addEventListener('click', createUser);
  el('add-existing-user-btn').addEventListener('click', addExistingUser);
  el('admin-book-search').addEventListener('input', () => {
    clearTimeout(adminSearchTimer);
    const q = el('admin-book-search').value.trim();
    if (q.length < 2) { hideDropdown('admin-search-dropdown'); return; }
    adminSearchTimer = setTimeout(() => doSearch(q, 'admin-search-dropdown', idx => adminPickBook(idx)), 420);
  });
  el('admin-clear-preview').addEventListener('click', adminClearPick);
  el('show-admin-add-book-btn').addEventListener('click', () => el('admin-add-book-form').classList.toggle('hidden'));
  el('admin-cancel-add-book-btn').addEventListener('click', () => el('admin-add-book-form').classList.add('hidden'));
  el('admin-add-book-btn').addEventListener('click', adminAddBook);
  el('admin-create-session-btn').addEventListener('click', adminCreateSession);
  el('admin-close-session-btn').addEventListener('click', adminCloseSession);
  el('analytics-run-btn').addEventListener('click', loadAnalytics);
  el('analytics-from').addEventListener('change', () => applyAnalyticsFilters('admin'));
  el('analytics-to').addEventListener('change', () => applyAnalyticsFilters('admin'));
  el('analytics-member').addEventListener('change', () => applyAnalyticsFilters('admin'));
  el('analytics-status').addEventListener('change', () => applyAnalyticsFilters('admin'));
  el('detail-close-btn').addEventListener('click', () => closeModal('details-modal'));
  el('edit-book-save-btn').addEventListener('click', saveEditBook);
  el('edit-book-cancel-btn').addEventListener('click', () => closeModal('edit-book-modal'));
  el('pwd-modal-close').addEventListener('click', () => closeModal('password-modal'));
}

/* ── Admin: Clubs ────────────────────────────────────── */
async function loadAdminClubs() {
  try {
    allClubs = await api('/api/bookclubs');
    populateAdminClubSelect();
    renderClubsGrid();
  } catch(e) { console.error(e); }
}

function renderClubsGrid() {
  const grid = el('clubs-list');
  if (!allClubs.length) { grid.innerHTML = `<p class="dim">No book clubs yet. Create one above.</p>`; return; }
  grid.innerHTML = allClubs.map(c => `
    <div class="club-card">
      <h3>${esc(c.name)}</h3>
      <p class="dim">${esc(c.description || 'No description')}</p>
      <p class="dim" style="font-size:.78rem;margin-top:.25rem">Created ${fmtDate(c.created_at)}</p>
      <div class="club-card-actions">
        <button class="btn btn-danger btn-xs" onclick="deleteClub(${c.id})">Delete Club</button>
      </div>
    </div>`).join('');
}

async function createClub() {
  const name = el('new-club-name').value.trim();
  const desc = el('new-club-desc').value.trim();
  if (!name) return;
  try {
    const club = await api('/api/bookclubs', 'POST', { name, description: desc });
    allClubs.push(club);
    el('new-club-name').value = ''; el('new-club-desc').value = '';
    el('create-club-form').classList.add('hidden');
    populateAdminClubSelect();
    renderClubsGrid();
  } catch (e) { showMsg('create-club-msg', e.message, 'error'); }
}

async function deleteClub(id) {
  if (!confirm('Delete this book club and all its books? This cannot be undone.')) return;
  try {
    await api(`/api/bookclubs/${id}`, 'DELETE');
    allClubs = allClubs.filter(c => c.id !== id);
    populateAdminClubSelect();
    renderClubsGrid();
  } catch (e) { alert(e.message); }
}

/* ── Admin: Members ──────────────────────────────────── */
async function loadAdminMembers() {
  if (!adminClubId) return;
  const club = allClubs.find(c => c.id === adminClubId);
  el('members-club-label').textContent = club ? `— ${club.name}` : '';
  try {
    [clubMembers, allUsers] = await Promise.all([
      api(`/api/bookclubs/${adminClubId}/members`),
      api('/api/users'),
    ]);
    renderMembersList();
    populateExistingUsersSelect();
  } catch(e) { console.error(e); }
}

function renderMembersList() {
  const list = el('members-list');
  if (!clubMembers.length) { list.innerHTML = `<p class="dim">No members yet.</p>`; return; }
  list.innerHTML = clubMembers.map(u => {
    const roleBadge = u.club_role === 'admin'
      ? `<span class="role-badge role-badge-admin">Club Admin</span>`
      : `<span class="role-badge">Member</span>`;
    return `<div class="member-row">
      <div class="member-info">
        <strong>${esc(u.name)}</strong>
        <span>${esc(u.email)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
        ${roleBadge}
        <div class="action-group">
          <button class="btn btn-ghost btn-xs" onclick="resetUserPassword(${u.id})">Reset Pwd</button>
          <button class="btn btn-danger btn-xs" onclick="removeMember(${u.id})">Remove</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function populateExistingUsersSelect() {
  const sel = el('existing-user-select');
  const memberIds = clubMembers.map(m => m.id);
  const nonMembers = allUsers.filter(u => !memberIds.includes(u.id));
  sel.innerHTML = nonMembers.length
    ? [`<option value="">— select user —</option>`, ...nonMembers.map(u => `<option value="${u.id}">${esc(u.name)} (${esc(u.email)})</option>`)].join('')
    : `<option value="">All users are already members</option>`;
}

async function createUser() {
  const name  = el('new-user-name').value.trim();
  const email = el('new-user-email').value.trim();
  if (!name) return showMsg('create-user-msg', 'Name required', 'error');
  try {
    const data = await api('/api/users', 'POST', { name, email: email || undefined, bookclub_ids: [adminClubId] });
    el('new-user-name').value = ''; el('new-user-email').value = '';
    showMsg('create-user-msg', 'User created!', 'success');
    if (data.temp_password) {
      el('pwd-modal-email').textContent = email;
      el('pwd-modal-value').textContent  = data.temp_password;
      openModal('password-modal');
    }
    await loadAdminMembers();
  } catch (e) { showMsg('create-user-msg', e.message, 'error'); }
}

async function addExistingUser() {
  const userId = parseInt(el('existing-user-select').value);
  if (!userId) return;
  try {
    await api(`/api/bookclubs/${adminClubId}/members`, 'POST', { user_id: userId });
    showMsg('add-existing-msg', 'User added to club!', 'success');
    await loadAdminMembers();
  } catch (e) { showMsg('add-existing-msg', e.message, 'error'); }
}

async function removeMember(userId) {
  if (!confirm('Remove this member from the club?')) return;
  try {
    await api(`/api/bookclubs/${adminClubId}/members/${userId}`, 'DELETE');
    await loadAdminMembers();
  } catch (e) { alert(e.message); }
}

async function resetUserPassword(userId) {
  if (!confirm("Reset this user's password and send them a new invite email?")) return;
  try {
    const data = await api(`/api/users/${userId}/reset-password`, 'POST');
    const u = allUsers.find(x => x.id === userId);
    el('pwd-modal-email').textContent = u?.email || '';
    el('pwd-modal-value').textContent  = data.temp_password;
    openModal('password-modal');
  } catch (e) { alert(e.message); }
}

/* ── Admin: Books ────────────────────────────────────── */
async function loadAdminBooks() {
  if (!adminClubId) return;
  const club = allClubs.find(c => c.id === adminClubId);
  el('books-club-label').textContent = club ? `— ${club.name}` : '';
  try {
    [allBooks, clubMembers] = await Promise.all([
      api(`/api/bookclubs/${adminClubId}/books`),
      api(`/api/bookclubs/${adminClubId}/members`),
    ]);
    renderAdminBooksTable();
    populateSubmitterSelect('admin-book-submitter');
    populateSubmitterSelect('edit-submitter');
  } catch(e) { console.error(e); }
}

function populateSubmitterSelect(selectId) {
  const sel = el(selectId);
  sel.innerHTML = [`<option value="">— select member —</option>`, ...clubMembers.map(u => `<option value="${u.id}" data-name="${esc(u.name)}">${esc(u.name)}</option>`)].join('');
}

function renderAdminBooksTable() {
  const tbody = el('admin-books-tbody');
  if (!allBooks.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No books yet.</td></tr>`; return; }
  tbody.innerHTML = allBooks.map(b => {
    const cover = b.cover_url
      ? `<img class="thumb" src="${b.cover_url}" alt="" onerror="this.outerHTML='<div class=thumb-ph>&#128214;</div>'">`
      : `<div class="thumb-ph">&#128214;</div>`;
    const selectedBadge = b.selected
      ? `<span class="badge badge-selected">&#10003;</span>`
      : `<span class="badge badge-active">No</span>`;
    return `<tr>
      <td>${cover}</td>
      <td><strong>${esc(b.title)}</strong></td>
      <td>${esc(b.author || '—')}</td>
      <td>${esc(b.genre  || '—')}</td>
      <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
      <td>${esc(b.added_by_name || '—')}</td>
      <td>${fmtDate(b.submitted_at || b.added_at)}</td>
      <td>${selectedBadge}</td>
      <td>${b.selected_at ? fmtDate(b.selected_at) : '—'}</td>
      <td><div class="action-group">
        <button class="btn btn-ghost btn-xs" onclick="openEditBook(${b.id})">Edit</button>
        <button class="btn btn-ghost btn-xs" onclick="showAdminBookDetails(${b.id})">Details</button>
        <button class="btn btn-danger btn-xs" onclick="adminDeleteBook(${b.id})">Delete</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function adminPickBook(i) {
  adminPickedBook = window._searchResults[i];
  hideDropdown('admin-search-dropdown');
  el('admin-book-search').value  = '';
  el('admin-book-title').value   = adminPickedBook.title;
  el('admin-book-author').value  = adminPickedBook.author;
  el('admin-book-genre').value   = adminPickedBook.genre || '';
  el('admin-preview-title').textContent  = adminPickedBook.title;
  el('admin-preview-author').textContent = adminPickedBook.author;
  el('admin-preview-pages').textContent  = adminPickedBook.page_count ? `${adminPickedBook.page_count} pages` : '';
  el('admin-preview-genre').textContent  = adminPickedBook.genre ? `Genre: ${adminPickedBook.genre}` : '';
  const img = el('admin-preview-img');
  img.src = adminPickedBook.cover_url || ''; img.style.display = adminPickedBook.cover_url ? 'block' : 'none';
  el('admin-book-preview').classList.remove('hidden');
  if (adminPickedBook.open_library_id) {
    try {
      const info = await api(`/api/book-info?key=${encodeURIComponent(adminPickedBook.open_library_id)}`);
      adminPickedBook.description = info.description || null;
      if (info.genre && !adminPickedBook.genre) {
        adminPickedBook.genre = info.genre;
        el('admin-book-genre').value  = info.genre;
        el('admin-preview-genre').textContent = `Genre: ${info.genre}`;
      }
    } catch {}
  }
}

function adminClearPick() {
  adminPickedBook = null;
  ['admin-book-title','admin-book-author','admin-book-genre','admin-book-search'].forEach(id => el(id).value = '');
  el('admin-book-preview').classList.add('hidden');
}

async function adminAddBook() {
  const title        = el('admin-book-title').value.trim();
  const author       = el('admin-book-author').value.trim();
  const genre        = el('admin-book-genre').value.trim();
  const submitterSel = el('admin-book-submitter');
  const submitterId  = parseInt(submitterSel.value) || null;
  const submitterName= submitterId ? submitterSel.selectedOptions[0]?.dataset.name : null;
  const submittedAt  = el('admin-book-submitted-at').value || null;
  const selectedAt   = el('admin-book-selected-at').value  || null;
  if (!title) return showMsg('admin-add-book-msg', 'Title required', 'error');
  try {
    const book = await api(`/api/bookclubs/${adminClubId}/books`, 'POST', {
      title, author: author || null, genre: genre || null,
      cover_url:       adminPickedBook?.cover_url       || null,
      open_library_id: adminPickedBook?.open_library_id || null,
      page_count:      adminPickedBook?.page_count      || null,
      description:     adminPickedBook?.description     || null,
      added_by_name:    submitterName,
      added_by_user_id: submitterId,
      submitted_at: submittedAt ? new Date(submittedAt).toISOString() : null,
      selected:   !!selectedAt,
      selected_at: selectedAt ? new Date(selectedAt).toISOString() : null,
    });
    allBooks.unshift(book);
    adminClearPick();
    el('admin-add-book-form').classList.add('hidden');
    renderAdminBooksTable();
    showMsg('admin-add-book-msg', 'Book added!', 'success');
  } catch (e) { showMsg('admin-add-book-msg', e.message, 'error'); }
}

function openEditBook(id) {
  const b = allBooks.find(x => x.id === id);
  if (!b) return;
  if (!_editClubId) _editClubId = adminClubId;
  el('edit-book-id').value        = b.id;
  el('edit-title').value          = b.title;
  el('edit-author').value         = b.author || '';
  el('edit-genre').value          = b.genre  || '';
  el('edit-submitted-at').value   = b.submitted_at ? b.submitted_at.slice(0,10) : '';
  el('edit-selected-at').value    = b.selected_at  ? b.selected_at.slice(0,10)  : '';
  el('edit-page-count').value     = b.page_count || '';
  populateSubmitterSelect('edit-submitter');
  if (b.added_by_user_id) el('edit-submitter').value = b.added_by_user_id;
  openModal('edit-book-modal');
}

async function saveEditBook() {
  const id      = parseInt(el('edit-book-id').value);
  const clubId  = _editClubId || adminClubId;
  const sel     = el('edit-submitter');
  const submitterId   = parseInt(sel.value) || null;
  const submitterName = submitterId ? sel.selectedOptions[0]?.dataset.name : null;
  const selectedAt    = el('edit-selected-at').value || null;
  try {
    const updated = await api(`/api/bookclubs/${clubId}/books/${id}`, 'PATCH', {
      title:            el('edit-title').value.trim(),
      author:           el('edit-author').value.trim() || null,
      genre:            el('edit-genre').value.trim()  || null,
      page_count:       parseInt(el('edit-page-count').value) || null,
      submitted_at:     el('edit-submitted-at').value ? new Date(el('edit-submitted-at').value).toISOString() : null,
      selected:         !!selectedAt,
      selected_at:      selectedAt ? new Date(selectedAt).toISOString() : null,
      added_by_user_id: submitterId,
      added_by_name:    submitterId ? submitterName : null,
    });
    const idx = allBooks.findIndex(x => x.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    if (_editClubId === currentClubId) renderBooksTable();
    else renderAdminBooksTable();
    _editClubId = null;
    closeModal('edit-book-modal');
  } catch (e) { showMsg('edit-book-msg', e.message, 'error'); }
}

async function adminDeleteBook(id) {
  if (!confirm('Permanently delete this book?')) return;
  try {
    await api(`/api/bookclubs/${adminClubId}/books/${id}`, 'DELETE');
    allBooks = allBooks.filter(b => b.id !== id);
    renderAdminBooksTable();
  } catch (e) { alert(e.message); }
}

function showAdminBookDetails(id) { showBookDetails(id); }

/* ── Admin: Voting ───────────────────────────────────── */
async function loadAdminVoting() {
  if (!adminClubId) return;
  const club = allClubs.find(c => c.id === adminClubId);
  el('voting-club-label').textContent = club ? `— ${club.name}` : '';
  try { votingSession = await api(`/api/bookclubs/${adminClubId}/voting/session`); }
  catch { votingSession = null; }
  renderAdminVotingPanel();
  if (votingSession) await loadAdminResults();
}

function renderAdminVotingPanel() {
  const statusBox  = el('admin-session-status');
  const createBtn  = el('admin-create-session-btn');
  const closeBtn   = el('admin-close-session-btn');
  const resultsCard= el('admin-results-card');
  if (!votingSession) {
    statusBox.style.cssText = 'background:#fee2e2;color:#991b1b';
    statusBox.textContent   = 'No active voting session.';
    createBtn.classList.remove('hidden'); closeBtn.classList.add('hidden');
    resultsCard.classList.add('hidden');
  } else if (!votingSession.is_closed) {
    statusBox.style.cssText = 'background:#dcfce7;color:#166534';
    statusBox.textContent   = `Voting open — started ${fmtDate(votingSession.created_at)}`;
    createBtn.classList.add('hidden'); closeBtn.classList.remove('hidden');
    resultsCard.classList.remove('hidden');
  } else {
    statusBox.style.cssText = 'background:#dbeafe;color:#1e40af';
    statusBox.textContent   = `Voting closed on ${fmtDate(votingSession.closed_at)}`;
    createBtn.classList.remove('hidden'); closeBtn.classList.add('hidden');
    resultsCard.classList.remove('hidden');
  }
}

async function loadAdminResults() {
  if (!votingSession) return;
  try {
    const data = await api(`/api/bookclubs/${adminClubId}/voting/results/${votingSession.id}`);
    renderResults(data, el('admin-results-list'), el('admin-results-footer'), el('admin-voter-status'));
  } catch {}
}

async function adminCreateSession() {
  try {
    votingSession = await api(`/api/bookclubs/${adminClubId}/voting/session`, 'POST');
    renderAdminVotingPanel();
  } catch (e) { alert(e.message); }
}

async function adminCloseSession() {
  if (!votingSession || !confirm('Close voting and reveal results to all members?')) return;
  try {
    votingSession = await api(`/api/bookclubs/${adminClubId}/voting/session/${votingSession.id}/close`, 'PATCH');
    renderAdminVotingPanel();
    await loadAdminResults();
  } catch (e) { alert(e.message); }
}

/* ── Admin: Users (superadmin) ───────────────────────── */
async function loadAllUsers() {
  try {
    allUsers = await api('/api/users');
    renderAllUsersTable();
  } catch(e) { console.error(e); }
}

function renderAllUsersTable() {
  const tbody = el('users-tbody');
  if (!allUsers.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No users yet.</td></tr>`; return; }
  tbody.innerHTML = allUsers.map(u => {
    const globalBadge = u.role === 'superadmin'
      ? `<span class="role-badge role-badge-superadmin">Superadmin</span>`
      : `<span class="role-badge">Member</span>`;
    const toggleLabel = u.role === 'superadmin' ? 'Make Member' : 'Make Superadmin';
    const toggleRole  = u.role === 'superadmin' ? 'member' : 'superadmin';
    return `<tr>
      <td><strong>${esc(u.name)}</strong></td>
      <td>${esc(u.email)}</td>
      <td>${globalBadge}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td><div class="action-group">
        <button class="btn btn-ghost btn-xs" onclick="setUserRole(${u.id},'${toggleRole}')">${toggleLabel}</button>
        <button class="btn btn-ghost btn-xs" onclick="resetUserPassword(${u.id})">Reset Pwd</button>
        <button class="btn btn-danger btn-xs" onclick="deleteUser(${u.id})">Delete</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function setUserRole(userId, role) {
  try {
    await api(`/api/users/${userId}/role`, 'PATCH', { role });
    await loadAllUsers();
  } catch (e) { alert(e.message); }
}

async function deleteUser(id) {
  if (!confirm('Permanently delete this user?')) return;
  try {
    await api(`/api/users/${id}`, 'DELETE');
    await loadAllUsers();
  } catch (e) { alert(e.message); }
}

/* ── Analytics ───────────────────────────────────────── */
function computeAnalyticsFromBooks(books, members) {
  const selected = books.filter(b => b.selected);
  const by_user = members
    .map(u => ({
      id: u.id, name: u.name,
      submitted: books.filter(b => b.added_by_user_id === u.id).length,
      selected:  selected.filter(b => b.added_by_user_id === u.id).length,
    }))
    .filter(u => u.submitted > 0)
    .sort((a, b) => b.submitted - a.submitted);
  const genreMap = {};
  for (const b of books) {
    if (b.genre) { const g = b.genre.split(',')[0].trim(); if (g) genreMap[g]=(genreMap[g]||0)+1; }
  }
  const genres = Object.entries(genreMap).sort((a,b) => b[1]-a[1]);
  const by_month = {};
  for (const b of selected) {
    if (b.selected_at) { const m=new Date(b.selected_at).toISOString().slice(0,7); by_month[m]=(by_month[m]||0)+1; }
  }
  const withPages = books.filter(b => b.page_count);
  const avg_page_count = withPages.length
    ? Math.round(withPages.reduce((s,b)=>s+Number(b.page_count),0)/withPages.length) : null;
  return { total_submitted:books.length, total_read:selected.length,
           total_members:members.length, avg_page_count, by_user, genres, by_month };
}

async function loadAnalyticsCtx(ctx) {
  const clubId    = ctx === 'admin' ? adminClubId : currentClubId;
  const contentId = ctx === 'admin' ? 'analytics-content' : 'manage-analytics-content';
  if (!clubId) return;
  if (ctx === 'admin') {
    const club = allClubs.find(c => c.id === clubId);
    el('analytics-club-label').textContent = club ? `— ${club.name}` : '';
  }
  el(contentId).innerHTML = `<p class="dim text-center mt-sm">Loading…</p>`;
  try {
    [_aState[ctx].books, _aState[ctx].members] = await Promise.all([
      api(`/api/bookclubs/${clubId}/books`),
      api(`/api/bookclubs/${clubId}/members`),
    ]);
    populateAnalyticsMemberFilter(ctx);
    applyAnalyticsFilters(ctx);
  } catch { el(contentId).innerHTML = `<p class="dim">Error loading analytics.</p>`; }
}

function loadAnalytics()       { return loadAnalyticsCtx('admin'); }
function loadManageAnalytics() { return loadAnalyticsCtx('manage'); }

function populateAnalyticsMemberFilter(ctx) {
  const filterId = ctx === 'admin' ? 'analytics-member' : 'manage-analytics-member';
  const filterEl = el(filterId);
  if (!filterEl) return;
  const seen = new Map();
  for (const b of _aState[ctx].books) {
    if (b.added_by_user_id && !seen.has(b.added_by_user_id))
      seen.set(b.added_by_user_id, b.added_by_name || '?');
  }
  const submitters = [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a,b) => a.name.localeCompare(b.name));
  const cur = filterEl.value;
  filterEl.innerHTML = '<option value="">All members</option>' +
    submitters.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  if (cur) filterEl.value = cur;
}

function applyAnalyticsFilters(ctx) {
  const fromEl   = ctx === 'admin' ? 'analytics-from'   : 'manage-analytics-from';
  const toEl     = ctx === 'admin' ? 'analytics-to'     : 'manage-analytics-to';
  const memberEl = ctx === 'admin' ? 'analytics-member' : 'manage-analytics-member';

  const from      = el(fromEl)?.value   || '';
  const to        = el(toEl)?.value     || '';
  const memberVal = parseInt(el(memberEl)?.value) || 0;
  const statusVal = ctx === 'admin' ? (el('analytics-status')?.value || '') : '';

  let books = _aState[ctx].books;
  if (from || to) {
    const fromTs = from ? new Date(from).getTime() : 0;
    const toTs   = to   ? new Date(to+'T23:59:59.999Z').getTime() : Infinity;
    books = books.filter(b => {
      const t = new Date(b.submitted_at || b.added_at).getTime();
      return t >= fromTs && t <= toTs;
    });
  }
  if (memberVal) books = books.filter(b => b.added_by_user_id === memberVal);
  if (statusVal === 'selected') books = books.filter(b => b.selected);
  else if (statusVal === 'active')  books = books.filter(b => b.active_for_voting && !b.selected);
  else if (statusVal === 'removed') books = books.filter(b => !b.active_for_voting);

  _aState[ctx].filtered = books;
  closeAnalyticsDrilldown(ctx);
  renderAnalytics(computeAnalyticsFromBooks(books, _aState[ctx].members), ctx);
}

function renderAnalytics(d, ctx) {
  const contentId = ctx === 'admin' ? 'analytics-content' : 'manage-analytics-content';
  const maxByUser   = Math.max(...d.by_user.map(u => u.submitted), 1);
  const maxGenre    = d.genres.length ? d.genres[0][1] : 1;
  const monthEntries= Object.entries(d.by_month).sort();

  el(contentId).innerHTML = `
    <div class="stat-cards">
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','all')" title="Click to see these books">
        <div class="stat-value">${d.total_submitted}</div><div class="stat-label">Books Submitted</div></div>
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','selected')" title="Click to see these books">
        <div class="stat-value">${d.total_read}</div><div class="stat-label">Books Read</div></div>
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','members')" title="Click to see members">
        <div class="stat-value">${d.total_members}</div><div class="stat-label">Members</div></div>
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','pages')" title="Click to see books by page count">
        <div class="stat-value">${d.avg_page_count ?? '—'}</div><div class="stat-label">Avg Pages</div></div>
    </div>
    ${d.by_user.length ? `<div class="analytics-section"><h3>Submissions &amp; Selections by Member</h3>
      ${d.by_user.map(u => `<div class="bar-row clickable" onclick="showAnalyticsDrilldown('${ctx}','member',${u.id})" title="Click to see these books">
        <div class="bar-label" title="${esc(u.name)}">${esc(u.name)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(u.submitted/maxByUser*100)}%"></div></div>
        <div class="bar-count">${u.submitted}</div>
        <span class="clickable-count dim" style="font-size:.8rem;white-space:nowrap" onclick="event.stopPropagation();showAnalyticsDrilldown('${ctx}','member-selected',${u.id})" title="Click to see read books">${u.selected} selected</span>
      </div>`).join('')}</div>` : ''}
    ${d.genres.length ? `<div class="analytics-section"><h3>Genre Breakdown</h3>
      ${d.genres.map(([g, n]) => `<div class="bar-row clickable" onclick="showAnalyticsDrilldown('${ctx}','genre','${esc(g)}')" title="Click to see these books">
        <div class="bar-label" title="${esc(g)}">${esc(g)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(n/maxGenre*100)}%"></div></div>
        <div class="bar-count">${n}</div>
      </div>`).join('')}</div>` : ''}
    ${monthEntries.length ? `<div class="analytics-section"><h3>Books Read by Month</h3>
      <div class="month-grid">${monthEntries.map(([k, n]) => `<div class="month-pill clickable" onclick="showAnalyticsDrilldown('${ctx}','month','${k}')" title="Click to see these books">${k} &nbsp;&#x2022;&nbsp; ${n}</div>`).join('')}</div>
    </div>` : ''}
  `;
}

function showAnalyticsDrilldown(ctx, type, value) {
  if (type === 'members') { renderDrilldownMembers(ctx); return; }
  const f = _aState[ctx].filtered;
  let books, title;
  switch (type) {
    case 'all':      books = f;                                title = 'All Books'; break;
    case 'selected': books = f.filter(b => b.selected);       title = 'Books Read'; break;
    case 'pages':    books = [...f].filter(b=>b.page_count)
                       .sort((a,b)=>Number(b.page_count)-Number(a.page_count));
                                                               title = 'Books by Page Count'; break;
    case 'member': {
      books = f.filter(b => b.added_by_user_id === value);
      const u = _aState[ctx].members.find(m => m.id === value);
      title = `Submitted by ${u?.name || 'member'}`; break;
    }
    case 'member-selected': {
      books = f.filter(b => b.added_by_user_id === value && b.selected);
      const u = _aState[ctx].members.find(m => m.id === value);
      title = `Read from ${u?.name || 'member'}`; break;
    }
    case 'genre': books = f.filter(b=>b.genre?.split(',')[0]?.trim()===value); title = `Genre: ${value}`; break;
    case 'month': books = f.filter(b=>b.selected_at?.slice(0,7)===value);      title = `Read in ${value}`; break;
    default: return;
  }
  renderDrilldownBooks(ctx, title, books);
}

function renderDrilldownBooks(ctx, title, books) {
  const panelId = ctx === 'admin' ? 'analytics-drilldown' : 'manage-analytics-drilldown';
  const panel   = el(panelId);
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="drilldown-head">
      <h4>${esc(title)} <span class="dim">(${books.length})</span></h4>
      <button class="btn btn-ghost btn-sm" onclick="closeAnalyticsDrilldown('${ctx}')">&#x2715; Close</button>
    </div>
    <div class="drilldown-body">
      ${books.length ? books.map(b => {
        const cover = b.cover_url
          ? `<img src="${b.cover_url}" alt="" onerror="this.style.display='none'" class="drilldown-thumb">`
          : `<div class="drilldown-thumb-ph">&#128214;</div>`;
        const meta = [b.author,
          b.page_count ? Number(b.page_count).toLocaleString()+' pp' : null,
          b.genre?.split(',')[0]?.trim()].filter(Boolean).join(' · ');
        const subline = [b.added_by_name ? 'by '+esc(b.added_by_name) : null, fmtDate(b.submitted_at||b.added_at)]
          .filter(Boolean).join(' · ');
        const selBadge = b.selected ? `<span class="badge badge-selected" style="font-size:.7rem">&#10003;</span>` : '';
        return `<div class="drilldown-book-item">
          ${cover}
          <div class="drilldown-book-info">
            <div class="drilldown-book-title">${esc(b.title)} ${selBadge}</div>
            <div class="drilldown-book-meta">${esc(meta)}</div>
            ${subline ? `<div class="drilldown-book-meta">${subline}</div>` : ''}
          </div>
          <button class="btn btn-ghost btn-xs" onclick="showDrilldownBookDetails(${b.id},'${ctx}')">Details</button>
        </div>`;
      }).join('') : `<p class="dim" style="padding:.75rem 0">No books.</p>`}
    </div>`;
  panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function renderDrilldownMembers(ctx) {
  const panelId = ctx === 'admin' ? 'analytics-drilldown' : 'manage-analytics-drilldown';
  const panel   = el(panelId);
  const members = _aState[ctx].members;
  const f       = _aState[ctx].filtered;
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="drilldown-head">
      <h4>Members <span class="dim">(${members.length})</span></h4>
      <button class="btn btn-ghost btn-sm" onclick="closeAnalyticsDrilldown('${ctx}')">&#x2715; Close</button>
    </div>
    <div class="drilldown-body">
      ${members.length ? members.map(u => {
        const submitted = f.filter(b => b.added_by_user_id === u.id).length;
        const selected  = f.filter(b => b.added_by_user_id === u.id && b.selected).length;
        const roleBadge = u.club_role === 'admin'
          ? `<span class="role-badge role-badge-admin">Club Admin</span>`
          : `<span class="role-badge">Member</span>`;
        const booksBtn = submitted > 0
          ? `<button class="btn btn-ghost btn-xs" onclick="showAnalyticsDrilldown('${ctx}','member',${u.id})">Books &#8594;</button>`
          : '';
        return `<div class="drilldown-member-item">
          <div class="drilldown-member-info">
            <div style="display:flex;align-items:center;gap:.35rem">
              <strong style="font-size:.88rem">${esc(u.name)}</strong>
              ${roleBadge}
            </div>
            <div style="font-size:.78rem;color:var(--muted)">${esc(u.email || '')}</div>
            <div style="font-size:.78rem;color:var(--muted)">${submitted} submitted &middot; ${selected} read</div>
          </div>
          ${booksBtn}
        </div>`;
      }).join('') : `<p class="dim" style="padding:.75rem 0">No members.</p>`}
    </div>`;
  panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function closeAnalyticsDrilldown(ctx) {
  const id = ctx === 'admin' ? 'analytics-drilldown' : 'manage-analytics-drilldown';
  const panel = el(id);
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

/* ── Shared helpers ──────────────────────────────────── */
function renderResults(data, listEl, footerEl, voterEl) {
  const { results, total_voters, voter_status } = data;
  if (!results?.length) {
    listEl.innerHTML = `<p class="dim">No votes yet.</p>`;
    if (footerEl) footerEl.textContent = '';
  } else {
    const max = results[0].vote_count || 1;
    listEl.innerHTML = results.map((b, i) => {
      const img = b.cover_url
        ? `<img src="${b.cover_url}" alt="" onerror="this.outerHTML='<div class=rr-ph>&#128214;</div>'">`
        : `<div class="rr-ph">&#128214;</div>`;
      return `<div class="result-row">
        ${img}<div class="rr-info">
          <div class="rr-title">${esc(b.title)}${i === 0 ? ' &#127942;' : ''}</div>
          <div class="rr-author">${esc(b.author || '')}</div>
        </div>
        <div class="rr-bar-wrap"><div class="rr-bar" style="width:${Math.round(b.vote_count/max*100)}%"></div></div>
        <div class="rr-count">${b.vote_count}</div>
      </div>`;
    }).join('');
    if (footerEl) footerEl.textContent = `Total voters: ${total_voters}`;
  }
  if (voterEl) renderVoterStatus(voter_status, voterEl);
}

function renderVoterStatus(voter_status, voterEl) {
  if (!voter_status?.length) { voterEl.classList.add('hidden'); return; }
  const voted = voter_status.filter(m => m.voted).length;
  voterEl.classList.remove('hidden');
  voterEl.innerHTML = `<div class="voter-status">
    <div class="voter-status-head">Who voted <span class="voter-count">${voted} / ${voter_status.length}</span></div>
    <div class="voter-grid">
      ${voter_status.map(m =>
        `<div class="voter-chip ${m.voted ? 'voter-chip-voted' : 'voter-chip-pending'}">${esc(m.name)}</div>`
      ).join('')}
    </div>
  </div>`;
}

/* ── Utility ─────────────────────────────────────────── */
function el(id)   { return document.getElementById(id); }
function qsa(sel) { return document.querySelectorAll(sel); }
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}
function hideDropdown(id) { el(id).classList.add('hidden'); }
function openModal(id)    { el(id).classList.add('open'); }
function closeModal(id)   { el(id).classList.remove('open'); }
function showMsg(elId, text, type) {
  const p = el(elId); p.textContent = text; p.className = `msg msg-${type}`; p.classList.remove('hidden');
  setTimeout(() => p.classList.add('hidden'), 5000);
}

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (authToken) opts.headers['Authorization'] = `Bearer ${authToken}`;
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

init();
