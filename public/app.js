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
let _confirmCallback      = null;  // for the "type yes" confirm modal
let uploadedCoverUrl      = null;  // member add form
let adminUploadedCoverUrl = null;  // admin add form
let editCoverUrl          = null;  // admin edit modal (null = no change)
let memberEditCoverUrl    = null;  // member edit modal (null = no change)
let searchTimer      = null;
let adminSearchTimer = null;
let _memberSetup     = false;
let sortField        = 'added_at';
let sortDir          = 'desc';
let _expandedClubs   = new Set();

const _aState = {
  admin:  { books: [], members: [], filtered: [] },
  manage: { books: [], members: [], filtered: [] },
  stats:  { books: [], members: [], filtered: [] },
};

// Genres loaded from DB; fallback to defaults if API unavailable before login
let genreList     = [];
let genreListFull = [];
const GENRE_DEFAULTS = [
  'Adventure', 'Biography / Memoir', 'Business', "Children's", 'Crime',
  'Fantasy', 'Fiction', 'Graphic Novel', 'Historical Fiction', 'Horror',
  'Humor', 'Literary Fiction', 'Mystery', 'Non-Fiction', 'Philosophy',
  'Poetry', 'Romance', 'Science', 'Science Fiction', 'Self-Help',
  'Short Stories', 'Spirituality', 'Thriller', 'True Crime', 'Young Adult',
];

async function loadGenres() {
  try {
    genreListFull = await api('/api/genres');
    genreList     = genreListFull.map(g => g.name);
  } catch {
    genreList     = [...GENRE_DEFAULTS];
    genreListFull = GENRE_DEFAULTS.map((name, i) => ({ id: -(i + 1), name }));
  }
}

function buildGenreCheckboxes(containerId, currentValue) {
  const selected = new Set(
    (currentValue || '').split(',').map(g => g.trim()).filter(Boolean)
  );
  const list = genreList.length ? genreList : GENRE_DEFAULTS;
  el(containerId).innerHTML = list.map(g =>
    `<label class="genre-cb-item">
      <input type="checkbox" value="${esc(g)}"${selected.has(g) ? ' checked' : ''}> ${esc(g)}
    </label>`
  ).join('');
}

function getGenreValues(containerId) {
  return [...el(containerId).querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => cb.value).join(', ') || null;
}

function _aCtxId(ctx, admin, manage, stats) {
  if (ctx === 'admin')  return admin;
  if (ctx === 'manage') return manage;
  return stats;
}

/* ── Boot ───────────────────────────────────────────────────────────────────── */
async function init() {
  // Show public home while loading
  el('public-home').classList.remove('hidden');
  el('login-page').classList.add('hidden');
  el('quick-login-page').classList.add('hidden');
  el('member-app').classList.add('hidden');
  el('admin-app').classList.add('hidden');

  // Details modal close works from any page
  el('detail-close-btn').addEventListener('click', () => closeModal('details-modal'));

  // Edit-book modal — wired globally so club admins (member view) can save too
  el('edit-book-save-btn').addEventListener('click', saveEditBook);
  el('edit-book-cancel-btn').addEventListener('click', () => closeModal('edit-book-modal'));

  // "Type yes" confirm modal
  el('confirm-modal-input').addEventListener('input', () => {
    el('confirm-modal-ok').disabled =
      el('confirm-modal-input').value.trim().toLowerCase() !== 'yes';
  });
  el('confirm-modal-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !el('confirm-modal-ok').disabled) el('confirm-modal-ok').click();
  });
  el('confirm-modal-ok').addEventListener('click', () => {
    if (el('confirm-modal-input').value.trim().toLowerCase() !== 'yes') return;
    closeModal('confirm-modal');
    if (_confirmCallback) { _confirmCallback(); _confirmCallback = null; }
  });
  el('confirm-modal-cancel').addEventListener('click', () => {
    closeModal('confirm-modal'); _confirmCallback = null;
  });

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
  el('quick-login-page').classList.add('hidden');
  el('login-page').classList.remove('hidden');
  el('member-app').classList.add('hidden');
  el('admin-app').classList.add('hidden');
}

function showQuickLogin() {
  el('public-home').classList.add('hidden');
  el('login-page').classList.add('hidden');
  el('quick-login-page').classList.remove('hidden');
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
  await loadGenres();
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
el('public-quick-signin-btn').addEventListener('click', showQuickLogin);
el('login-back-btn').addEventListener('click', () => {
  el('login-page').classList.add('hidden');
  el('public-home').classList.remove('hidden');
});
el('quick-back-btn').addEventListener('click', () => {
  el('quick-login-page').classList.add('hidden');
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

  const bookRows = visible.length ? (() => {
    const rows = visible.map(b => {
      const cover = b.cover_url
        ? `<img class="thumb-sm" src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
        : `<div class="thumb-sm-ph">&#128214;</div>`;
      const coverCard = b.cover_url
        ? `<img src="${b.cover_url}" alt="" onerror="this.style.display='none'" style="width:32px;height:48px;object-fit:cover;border-radius:3px;flex-shrink:0">`
        : `<div class="pub-book-ph">&#128214;</div>`;
      const badge = b.selected
        ? `<span class="badge badge-selected">&#10003; Selected</span>`
        : !b.active_for_voting
          ? `<span class="badge badge-on-hold">On Hold</span>`
          : `<span class="badge badge-active">Active</span>`;
      const metaParts = [
        b.author || null,
        b.page_count ? `${Number(b.page_count).toLocaleString()} pp` : null,
      ].filter(Boolean);
      return { cover, coverCard, badge, metaParts, b };
    });

    const tableHtml = `<div class="pub-table-wrap">
        <table class="pub-books-table">
          <thead><tr>
            <th>Cover</th><th>Title</th><th>Author</th><th>Pages</th><th>Status</th>
          </tr></thead>
          <tbody>${rows.map(({ cover, badge, b }) => `<tr>
              <td><div class="cover-cell">${cover}<button class="btn btn-ghost btn-xs" onclick="showPublicBookDetails(${c.id},${b.id})">Details</button></div></td>
              <td><strong>${esc(b.title)}</strong></td>
              <td>${esc(b.author || '—')}</td>
              <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
              <td>${badge}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;

    const cardsHtml = `<div class="pub-books-cards">${rows.map(({ coverCard, badge, metaParts, b }) =>
      `<div class="public-book-item">
        ${coverCard}
        <div class="pub-book-info">
          <div class="pub-book-title">${esc(b.title)}</div>
          ${metaParts.length ? `<div class="pub-book-author">${esc(metaParts.join(' · '))}</div>` : ''}
        </div>
        <div class="pub-book-item-right">${badge}<button class="btn btn-ghost btn-xs" onclick="showPublicBookDetails(${c.id},${b.id})">Details</button></div>
      </div>`).join('')}</div>`;

    return tableHtml + cardsHtml;
  })()
    : `<p class="dim" style="font-size:.85rem;padding:.5rem 0">No books yet.</p>`;

  const expandBtn = !expanded && hasMore
    ? `<button class="btn btn-ghost btn-sm pub-expand-btn" onclick="expandPublicClub(${c.id})">View all ${c.books.length} books →</button>`
    : expanded && c.books.length > LIMIT
      ? `<button class="btn btn-ghost btn-sm pub-expand-btn" onclick="collapsePublicClub(${c.id})">Show less ↑</button>`
      : '';

  const booksRead = c.books_read || 0;
  const pagesRead = c.pages_read || 0;
  const statsLine = [
    `${c.books.length} book${c.books.length !== 1 ? 's' : ''}`,
    booksRead > 0 ? `${booksRead} read` : null,
    pagesRead > 0 ? `${pagesRead.toLocaleString()} pages read` : null,
  ].filter(Boolean).join(' · ');

  return `<div class="public-club-card">
    <h3>${esc(c.name)}</h3>
    ${c.description ? `<p class="dim" style="font-size:.85rem;margin-bottom:.5rem">${esc(c.description)}</p>` : ''}
    <p class="pub-book-count dim">${statsLine}</p>
    ${bookRows}
    ${expandBtn}
  </div>`;
}

function showPublicBookDetails(clubId, bookId) {
  const club = window._publicClubs?.find(c => c.id === clubId);
  showBookDetailsForBook(club?.books?.find(x => x.id === bookId));
}

function expandPublicClub(clubId)   { _expandedClubs.add(clubId);    renderPublicGrid(); }
function collapsePublicClub(clubId) { _expandedClubs.delete(clubId); renderPublicGrid(); }

/* ══════════════════════════════════════════════════════════════════════════════
   MEMBER APP
══════════════════════════════════════════════════════════════════════════════ */
function showMember() {
  el('public-home').classList.add('hidden');
  el('login-page').classList.add('hidden');
  el('quick-login-page').classList.add('hidden');
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
    loadMemberStats();
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
      if (btn.dataset.tab === 'stats')  loadMemberStats();
      if (btn.dataset.tab === 'manage') loadManageTab();
    });
  });
}

function setupMemberListeners() {
  buildGenreCheckboxes('book-genre-select', '');
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
  el('show-member-add-book-btn').addEventListener('click', () => el('member-add-book-form').classList.toggle('hidden'));
  el('member-cancel-add-book-btn').addEventListener('click', () => el('member-add-book-form').classList.add('hidden'));
  el('submit-vote-btn').addEventListener('click', submitVote);

  // Manage tab
  el('manage-create-user-btn').addEventListener('click', createMemberFromManage);
  el('nm-set-btn').addEventListener('click', showNmForm);
  el('nm-edit-btn').addEventListener('click', showNmForm);
  el('nm-cancel-btn').addEventListener('click', () => { el('nm-form').classList.add('hidden'); el('nm-msg').className = 'msg hidden'; renderNmDisplay(_nmData); });
  el('nm-save-btn').addEventListener('click', saveNextMeeting);
  el('nm-clear-btn').addEventListener('click', clearNextMeeting);
  el('manage-create-session-btn').addEventListener('click', manageCreateSession);
  el('manage-close-session-btn').addEventListener('click', manageCloseSession);
  // Stats tab
  el('stats-run-btn').addEventListener('click', loadMemberStats);
  el('stats-from').addEventListener('change', () => applyAnalyticsFilters('stats'));
  el('stats-to').addEventListener('change', () => applyAnalyticsFilters('stats'));
  el('stats-member').addEventListener('change', () => applyAnalyticsFilters('stats'));

  // Member edit modal
  el('member-edit-save-btn').addEventListener('click', saveMemberEdit);
  el('member-edit-cancel-btn').addEventListener('click', () => closeModal('member-edit-modal'));

  // Filter controls
  el('book-filter-text').addEventListener('input', renderBooksTable);
  el('book-filter-genre').addEventListener('change', renderBooksTable);
  el('book-filter-submitter').addEventListener('change', renderBooksTable);
  el('book-filter-status').addEventListener('change', renderBooksTable);

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
  el('stats-club-label').textContent = club ? `— ${club.name}` : '';
  el('books-loading').classList.remove('hidden');
  el('table-wrap').classList.add('hidden');
  try {
    allBooks = await api(`/api/bookclubs/${currentClubId}/books`);
    populateGenreFilter();
    populateMemberBookFilters();
    renderBooksTable();
  } finally { el('books-loading').classList.add('hidden'); }
  await refreshVoteTab();
  await loadNextMeeting(currentClubId);
}

/* ── Next Meeting ────────────────────────────────────────────────────────────── */
let _nmData = null;       // cached member next-meeting data
let _adminNmData = null;  // cached admin next-meeting data

async function loadNextMeeting(clubId) {
  try {
    const data = await api(`/api/bookclubs/${clubId}/next-meeting`);
    renderNextMeetingBanner(data);
  } catch { renderNextMeetingBanner(null); }
}

function formatMeetingDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })
       + ' at ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
}

function renderNextMeetingBanner(data, targetId = 'next-meeting-banner') {
  const banner = el(targetId);
  if (!banner) return;
  const hasBook    = data?.title;
  const hasDate    = data?.next_meeting_at;
  const hasLocation = data?.next_meeting_location;
  if (!hasBook && !hasDate && !hasLocation) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  const cover = hasBook && data.cover_url
    ? `<img class="nm-cover-img" src="${esc(data.cover_url)}" alt="${esc(data.title)}">`
    : hasBook
      ? `<div class="nm-cover-ph">&#128214;</div>`
      : '';
  const dateStr = hasDate ? formatMeetingDate(data.next_meeting_at) : '';
  banner.innerHTML = `
    <div class="nm-banner-inner">
      <div class="nm-book-side">
        <div class="nm-cover">${cover}</div>
        <div class="nm-book-info">
          <div class="nm-label">Next Meeting</div>
          ${hasBook   ? `<div class="nm-title">${esc(data.title)}</div>` : ''}
          ${data.author ? `<div class="nm-meta">by ${esc(data.author)}</div>` : ''}
          ${data.genre  ? `<div class="nm-meta">${esc(data.genre)}</div>` : ''}
          ${data.page_count ? `<div class="nm-meta">${data.page_count} pages${data.release_year ? ' · ' + data.release_year : ''}</div>` : ''}
          ${data.added_by_name ? `<div class="nm-meta dim">Submitted by ${esc(data.added_by_name)}</div>` : ''}
        </div>
      </div>
      <div class="nm-when-side">
        ${dateStr    ? `<div class="nm-when"><span class="nm-icon">&#128197;</span> ${esc(dateStr)}</div>` : ''}
        ${hasLocation ? `<div class="nm-where"><span class="nm-icon">&#128205;</span> ${esc(data.next_meeting_location)}</div>` : ''}
      </div>
    </div>`;
  banner.classList.remove('hidden');
}

/* Render meeting display card (shared by member and admin manage tabs) */
function _renderNmDisplay(data, displayId, emptyId, editBtnId, setBtnId) {
  const display = el(displayId);
  const emptyEl = el(emptyId);
  const editBtn = el(editBtnId);
  const setBtn  = el(setBtnId);
  if (!display) return;
  const hasBook     = data?.title;
  const hasDate     = data?.next_meeting_at;
  const hasLocation = data?.next_meeting_location;
  if (!hasBook && !hasDate && !hasLocation) {
    display.classList.add('hidden');
    display.innerHTML = '';
    emptyEl.classList.remove('hidden');
    editBtn.classList.add('hidden');
    setBtn.classList.remove('hidden');
    return;
  }
  const cover = hasBook && data.cover_url
    ? `<img src="${esc(data.cover_url)}" alt="" style="width:48px;height:72px;object-fit:cover;border-radius:4px;flex-shrink:0">`
    : hasBook
      ? `<div style="width:48px;height:72px;background:var(--border-soft);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">&#128214;</div>`
      : '';
  const dateStr = hasDate ? formatMeetingDate(data.next_meeting_at) : '';
  display.innerHTML = `
    <div style="display:flex;gap:.75rem;align-items:flex-start;margin-bottom:.25rem">
      ${hasBook ? cover : ''}
      <div style="flex:1;display:flex;flex-direction:column;gap:.2rem">
        ${hasBook    ? `<strong>${esc(data.title)}</strong>` : ''}
        ${data?.author ? `<span class="dim" style="font-size:.85rem">by ${esc(data.author)}</span>` : ''}
        ${dateStr    ? `<span class="dim" style="font-size:.85rem">&#128197; ${esc(dateStr)}</span>` : ''}
        ${hasLocation ? `<span class="dim" style="font-size:.85rem">&#128205; ${esc(data.next_meeting_location)}</span>` : ''}
      </div>
    </div>`;
  display.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  editBtn.classList.remove('hidden');
  setBtn.classList.add('hidden');
}
function renderNmDisplay(data) {
  _renderNmDisplay(data, 'nm-display', 'nm-empty', 'nm-edit-btn', 'nm-set-btn');
}
function renderAdminNmDisplay(data) {
  _renderNmDisplay(data, 'admin-nm-display', 'admin-nm-empty', 'admin-nm-edit-btn', 'admin-nm-set-btn');
}

/* Load and display current meeting for member Manage tab */
async function loadManageNextMeeting(clubId) {
  try {
    _nmData = await api(`/api/bookclubs/${clubId}/next-meeting`);
    renderNmDisplay(_nmData);
  } catch { _nmData = null; renderNmDisplay(null); }
}

/* Show the edit form for member Manage tab */
function showNmForm() {
  const sel = el('nm-book-select');
  const activeBooks = allBooks.filter(b => !b.archived);
  sel.innerHTML = '<option value="">— No book selected —</option>' +
    activeBooks.map(b => `<option value="${b.id}">${esc(b.title)}${b.author ? ' — ' + esc(b.author) : ''}</option>`).join('');
  const data = _nmData;
  sel.value = '';
  el('nm-location').value = '';
  el('nm-date').value = '';
  el('nm-time').value = '';
  if (data?.next_book_id) sel.value = data.next_book_id;
  if (data?.next_meeting_location) el('nm-location').value = data.next_meeting_location;
  if (data?.next_meeting_at) {
    const d = new Date(data.next_meeting_at);
    el('nm-date').value = d.toISOString().slice(0, 10);
    el('nm-time').value = d.toTimeString().slice(0, 5);
  }
  el('nm-display').classList.add('hidden');
  el('nm-empty').classList.add('hidden');
  el('nm-edit-btn').classList.add('hidden');
  el('nm-set-btn').classList.add('hidden');
  el('nm-form').classList.remove('hidden');
  el('nm-msg').className = 'msg hidden';
}

async function saveNextMeeting() {
  const clubId = currentClubId;
  const bookId   = el('nm-book-select').value || null;
  const location = el('nm-location').value.trim() || null;
  const dateVal  = el('nm-date').value;
  const timeVal  = el('nm-time').value || '00:00';
  const meetingAt = dateVal ? new Date(`${dateVal}T${timeVal}`).toISOString() : null;
  const msg = el('nm-msg');
  msg.className = 'msg hidden';
  try {
    await api(`/api/bookclubs/${clubId}/next-meeting`, 'PATCH', { book_id: bookId ? parseInt(bookId) : null, meeting_at: meetingAt, location });
    el('nm-form').classList.add('hidden');
    await loadNextMeeting(clubId);
    await loadManageNextMeeting(clubId);
  } catch (e) {
    msg.textContent = e.message || 'Error saving';
    msg.className = 'msg msg-error';
  }
}

async function clearNextMeeting() {
  const clubId = currentClubId;
  const msg = el('nm-msg');
  msg.className = 'msg hidden';
  try {
    await api(`/api/bookclubs/${clubId}/next-meeting`, 'PATCH', { book_id: null, meeting_at: null, location: null });
    el('nm-form').classList.add('hidden');
    renderNextMeetingBanner(null);
    await loadManageNextMeeting(clubId);
  } catch (e) {
    msg.textContent = e.message || 'Error clearing';
    msg.className = 'msg msg-error';
  }
}

/* ── Next Meeting — Admin View ───────────────────────────────────────────────── */
async function loadAdminNextMeeting() {
  if (!adminClubId) return;
  try {
    const data = await api(`/api/bookclubs/${adminClubId}/next-meeting`);
    renderNextMeetingBanner(data, 'admin-next-meeting-banner');
  } catch { renderNextMeetingBanner(null, 'admin-next-meeting-banner'); }
}

/* Load and display current meeting for admin Manage tab */
async function loadAdminManageNm() {
  if (!adminClubId) return;
  try {
    _adminNmData = await api(`/api/bookclubs/${adminClubId}/next-meeting`);
    renderAdminNmDisplay(_adminNmData);
  } catch { _adminNmData = null; renderAdminNmDisplay(null); }
}

/* Show the edit form for admin Manage tab */
async function showAdminNmForm() {
  if (!adminClubId) return;
  const sel = el('admin-nm-book-select');
  if (!sel) return;
  let books = _aState.admin.books.filter(b => !b.archived);
  if (!books.length) {
    try {
      const fetched = await api(`/api/bookclubs/${adminClubId}/books`);
      _aState.admin.books = fetched;
      books = fetched.filter(b => !b.archived);
    } catch { books = []; }
  }
  sel.innerHTML = '<option value="">— No book selected —</option>' +
    books.map(b => `<option value="${b.id}">${esc(b.title)}${b.author ? ' — ' + esc(b.author) : ''}</option>`).join('');
  const data = _adminNmData;
  sel.value = '';
  el('admin-nm-location').value = '';
  el('admin-nm-date').value = '';
  el('admin-nm-time').value = '';
  if (data?.next_book_id) sel.value = data.next_book_id;
  if (data?.next_meeting_location) el('admin-nm-location').value = data.next_meeting_location;
  if (data?.next_meeting_at) {
    const d = new Date(data.next_meeting_at);
    el('admin-nm-date').value = d.toISOString().slice(0, 10);
    el('admin-nm-time').value = d.toTimeString().slice(0, 5);
  }
  el('admin-nm-display').classList.add('hidden');
  el('admin-nm-empty').classList.add('hidden');
  el('admin-nm-edit-btn').classList.add('hidden');
  el('admin-nm-set-btn').classList.add('hidden');
  el('admin-nm-form').classList.remove('hidden');
  el('admin-nm-msg').className = 'msg hidden';
}

async function saveAdminNextMeeting() {
  const clubId   = adminClubId;
  const bookId   = el('admin-nm-book-select').value || null;
  const location = el('admin-nm-location').value.trim() || null;
  const dateVal  = el('admin-nm-date').value;
  const timeVal  = el('admin-nm-time').value || '00:00';
  const meetingAt = dateVal ? new Date(`${dateVal}T${timeVal}`).toISOString() : null;
  const msg = el('admin-nm-msg');
  msg.className = 'msg hidden';
  try {
    await api(`/api/bookclubs/${clubId}/next-meeting`, 'PATCH', { book_id: bookId ? parseInt(bookId) : null, meeting_at: meetingAt, location });
    el('admin-nm-form').classList.add('hidden');
    await loadAdminNextMeeting();
    await loadAdminManageNm();
  } catch (e) {
    msg.textContent = e.message || 'Error saving';
    msg.className = 'msg msg-error';
  }
}

async function clearAdminNextMeeting() {
  const clubId = adminClubId;
  const msg = el('admin-nm-msg');
  msg.className = 'msg hidden';
  try {
    await api(`/api/bookclubs/${clubId}/next-meeting`, 'PATCH', { book_id: null, meeting_at: null, location: null });
    el('admin-nm-form').classList.add('hidden');
    renderNextMeetingBanner(null, 'admin-next-meeting-banner');
    await loadAdminManageNm();
  } catch (e) {
    msg.textContent = e.message || 'Error clearing';
    msg.className = 'msg msg-error';
  }
}

function populateGenreFilter() {
  const list = genreList.length ? genreList : GENRE_DEFAULTS;
  const cur = el('book-filter-genre').value;
  el('book-filter-genre').innerHTML =
    '<option value="">All genres</option>' +
    list.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  if (cur) el('book-filter-genre').value = cur;
}

/* ── Book List (member) ──────────────────────────────── */
function populateMemberBookFilters() {
  const sel = el('book-filter-submitter');
  if (!sel) return;
  const seen = new Map();
  for (const b of allBooks) {
    if (b.added_by_user_id && !seen.has(b.added_by_user_id))
      seen.set(b.added_by_user_id, b.added_by_name || '?');
  }
  const current = sel.value;
  sel.innerHTML = `<option value="">All members</option>` +
    [...seen.entries()].sort((a,b)=>a[1].localeCompare(b[1]))
      .map(([id, name]) => `<option value="${id}"${String(id)===current?' selected':''}>${esc(name)}</option>`).join('');
}

function renderBooksTable() {
  const showInactive = el('show-inactive').checked;
  const q          = (el('book-filter-text')?.value || '').trim().toLowerCase();
  const genre      = el('book-filter-genre')?.value  || '';
  const submitter  = el('book-filter-submitter')?.value || '';
  const status     = el('book-filter-status')?.value  || '';

  let books = showInactive ? allBooks : allBooks.filter(b => !b.archived);
  if (q)         books = books.filter(b =>
    b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q));
  if (genre)     books = books.filter(b =>
    b.genre?.split(',').map(g => g.trim()).includes(genre));
  if (submitter) books = books.filter(b => String(b.added_by_user_id) === submitter);
  if (status === 'voting')    books = books.filter(b => b.active_for_voting && !b.selected && !b.archived);
  if (status === 'selected')  books = books.filter(b => b.selected);

  // client-side sort
  books = [...books].sort((a, b) => {
    let va = a[sortField], vb = b[sortField];
    if (sortField === 'added_at') {
      va = new Date(a.submitted_at || a.added_at).getTime();
      vb = new Date(b.submitted_at || b.added_at).getTime();
    } else if (sortField === 'page_count' || sortField === 'release_year') {
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
  const cards = el('books-cards');
  const empty = el('no-books');

  if (!books.length) {
    wrap.classList.add('hidden');
    cards.innerHTML = '';
    empty.classList.remove('hidden'); return;
  }
  wrap.classList.remove('hidden');
  empty.classList.add('hidden');

  const canAdmin = isClubAdmin(currentClubId);
  let tableRows = '';
  let cardRows  = '';

  books.forEach(b => {
    const isOwner = b.added_by_user_id === currentUser.id;
    const cover = b.cover_url
      ? `<img class="thumb" src="${b.cover_url}" alt="" onerror="this.outerHTML='<div class=thumb-ph>&#128214;</div>'">`
      : `<div class="thumb-ph">&#128214;</div>`;
    let badge;
    if (b.archived)      badge = `<span class="badge badge-removed">Archived</span>`;
    else if (b.selected) badge = `<span class="badge badge-selected">&#10003; Selected</span>`;
    else                 badge = `<span class="badge badge-active">Active</span>`;
    const canToggleVoting = (canAdmin || (isOwner && !b.selected)) && !b.archived;
    const votingCell = `<input type="checkbox" class="voting-cb" ${b.active_for_voting ? 'checked' : ''} ${canToggleVoting ? '' : 'disabled'}
      title="${b.archived ? 'Book is archived' : canToggleVoting ? 'Toggle voting eligibility' : 'Not your book'}"
      onchange="memberToggleVoting(${b.id})">`;
    const actions = [`<button class="btn btn-ghost btn-xs" onclick="showBookDetails(${b.id})">Details</button>`];
    if (canAdmin) {
      actions.push(`<button class="btn btn-ghost btn-xs" onclick="memberOpenEditBook(${b.id})">Edit</button>`);
    } else if (isOwner) {
      actions.push(`<button class="btn btn-ghost btn-xs" onclick="memberOpenOwnEdit(${b.id})">Edit</button>`);
    }
    if ((isOwner || canAdmin) && !b.selected) {
      actions.push(b.archived
        ? `<button class="btn btn-ghost btn-xs" onclick="memberArchiveBook(${b.id},false)">Unarchive</button>`
        : `<button class="btn btn-ghost btn-xs" onclick="memberArchiveBook(${b.id},true)">Archive</button>`);
    }
    if (canAdmin && !b.selected) {
      actions.push(`<button class="btn btn-danger btn-xs" onclick="memberDeleteBook(${b.id})">Delete</button>`);
    }

    // ── Desktop table row ──
    // actions[0] = Details → goes below cover; slice(1) = Edit/Archive → stay in actions col
    const coverCell = `<div class="cover-cell">${cover}${actions[0]}</div>`;
    tableRows += `<tr class="${b.archived ? 'inactive' : ''}">
      <td>${coverCell}</td>
      <td><strong>${esc(b.title)}</strong></td>
      <td>${esc(b.author || '—')}</td>
      <td>${esc(b.genre  || '—')}</td>
      <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
      <td>${b.release_year || '—'}</td>
      <td>${esc(b.added_by_name || '—')}</td>
      <td>${fmtDate(b.submitted_at || b.added_at)}</td>
      <td class="td-voting">${votingCell}</td>
      <td>${badge}</td>
      <td>${b.selected_at ? fmtDate(b.selected_at) : '—'}</td>
      <td><div class="action-group">${actions.slice(1).join('')}</div></td>
    </tr>`;

    // ── Mobile card ──
    const coverCard = b.cover_url
      ? `<img class="bc-cover-img" src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
      : `<div class="bc-cover-ph">&#128214;</div>`;
    const metaParts = [
      b.release_year || null,
      b.page_count ? `${Number(b.page_count).toLocaleString()} pp` : null,
      b.genre ? b.genre.split(',')[0].trim() : null,
    ].filter(Boolean);
    const votingCardCell = `<input type="checkbox" class="voting-cb" ${b.active_for_voting ? 'checked' : ''} ${canToggleVoting ? '' : 'disabled'}
      title="${b.archived ? 'Book is archived' : canToggleVoting ? 'Toggle voting' : 'Not your book'}"
      onchange="memberToggleVoting(${b.id})">`;
    const hasSynopsis = !!b.description;
    // actions[0] = Details (goes under cover), actions.slice(1) = Edit/Archive
    cardRows += `
      <div class="book-card ${b.archived ? 'book-card-inactive' : ''}" id="bc-${b.id}">
        <div class="bc-main">
          <div class="bc-cover">${coverCard}${actions[0]}</div>
          <div class="bc-info">
            <div class="bc-title">${esc(b.title)}</div>
            ${b.author ? `<div class="bc-author">${esc(b.author)}</div>` : ''}
            ${metaParts.length ? `<div class="bc-meta">${metaParts.join(' · ')}</div>` : ''}
            <div class="bc-badges">${badge} ${votingCardCell}</div>
            <div class="bc-submitted">By ${esc(b.added_by_name || '?')} · ${fmtDate(b.submitted_at || b.added_at)}</div>
            ${actions.slice(1).length ? `<div class="bc-actions">${actions.slice(1).join('')}</div>` : ''}
            ${hasSynopsis ? `<button class="bc-synopsis-btn" onclick="toggleSynopsis(${b.id},this)">View Synopsis ▾</button>` : ''}
          </div>
        </div>
        ${hasSynopsis ? `<div id="bc-syn-${b.id}" class="bc-synopsis hidden">${esc(b.description)}</div>` : ''}
      </div>`;
  });

  tbody.innerHTML = tableRows;
  cards.innerHTML = cardRows;
}

function toggleSynopsis(id, btn) {
  const syn = document.getElementById(`bc-syn-${id}`);
  if (!syn) return;
  const nowHidden = syn.classList.toggle('hidden');
  btn.textContent = nowHidden ? 'View Synopsis ▾' : 'Hide Synopsis ▴';
}

async function memberToggleVoting(id) {
  try {
    const updated = await api(`/api/bookclubs/${currentClubId}/books/${id}/toggle-voting`, 'PATCH', {});
    const idx = allBooks.findIndex(b => b.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    renderBooksTable();
  } catch (e) { alert(e.message); }
}

async function memberArchiveBook(id, archive) {
  try {
    const updated = await api(`/api/bookclubs/${currentClubId}/books/${id}/archive`, 'PATCH', { archived: archive });
    const idx = allBooks.findIndex(b => b.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    renderBooksTable();
  } catch (e) { alert(e.message); }
}

function memberDeleteBook(id) {
  const b = allBooks.find(x => x.id === id);
  confirmAction(
    'Delete Book',
    `Permanently delete "${b?.title || 'this book'}"? This cannot be undone.`,
    async () => {
      try {
        await api(`/api/bookclubs/${currentClubId}/books/${id}`, 'DELETE');
        allBooks = allBooks.filter(b => b.id !== id);
        renderBooksTable();
      } catch (e) { alert(e.message); }
    }
  );
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
  buildGenreCheckboxes('member-edit-genre-select', b.genre || '');
  el('member-edit-page-count').value = b.page_count || '';
  el('member-edit-year').value       = b.release_year || '';
  el('member-edit-desc').value       = b.description || '';
  const memVotingCb = el('member-edit-active-voting');
  memVotingCb.checked  = !!b.active_for_voting;
  memVotingCb.disabled = !!b.selected;
  el('member-edit-msg').classList.add('hidden');
  openModal('member-edit-modal');
  memberEditCoverUrl = null;
  el('cover-upload-thumb-medit').innerHTML = b.cover_url
    ? `<img src="${b.cover_url}" alt="Cover">` : '';
  el('cover-upload-thumb-medit').classList.toggle('hidden', !b.cover_url);
  el('cover-clear-medit').classList.add('hidden');
  showMsg('cover-upload-msg-medit', '', '');
}

async function saveMemberEdit() {
  const id = parseInt(el('member-edit-book-id').value);
  try {
    const updated = await api(`/api/bookclubs/${currentClubId}/books/${id}`, 'PATCH', {
      title:       el('member-edit-title').value.trim(),
      author:      el('member-edit-author').value.trim() || null,
      genre:             getGenreValues('member-edit-genre-select'),
      page_count:        parseInt(el('member-edit-page-count').value) || null,
      release_year:      parseInt(el('member-edit-year').value) || null,
      description:       el('member-edit-desc').value.trim() || null,
      active_for_voting: el('member-edit-active-voting').checked,
      ...(memberEditCoverUrl !== null && { cover_url: memberEditCoverUrl }),
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
  el('book-search').value       = '';
  el('book-title').value        = pickedBook.title;
  el('book-author').value       = pickedBook.author;
  el('book-page-count').value   = pickedBook.page_count || '';
  el('book-year').value         = pickedBook.release_year || '';
  el('book-description').value  = '';
  el('preview-title').textContent  = pickedBook.title;
  el('preview-author').textContent = pickedBook.author;
  const pageParts = [pickedBook.page_count ? `${pickedBook.page_count} pages` : '', pickedBook.release_year || ''].filter(Boolean);
  el('preview-pages').textContent  = pageParts.join(' · ');
  el('preview-genre').textContent  = '';
  el('preview-desc').textContent   = 'Loading description…';
  const img = el('preview-img');
  img.src = pickedBook.cover_url || ''; img.style.display = pickedBook.cover_url ? 'block' : 'none';
  el('book-preview').classList.remove('hidden');
  if (pickedBook.open_library_id) {
    try {
      const info = await api(`/api/book-info?key=${encodeURIComponent(pickedBook.open_library_id)}`);
      pickedBook.description = info.description || null;
      el('preview-desc').textContent = info.description || '';
      el('book-description').value   = info.description || '';
    } catch { el('preview-desc').textContent = ''; }
  } else { el('preview-desc').textContent = ''; }
}

/* ── Confirm Action (type "yes") ─────────────────────── */
function confirmAction(title, message, callback) {
  _confirmCallback = callback;
  el('confirm-modal-title').textContent = title;
  el('confirm-modal-msg').textContent   = message;
  el('confirm-modal-input').value       = '';
  el('confirm-modal-ok').disabled       = true;
  openModal('confirm-modal');
  setTimeout(() => el('confirm-modal-input').focus(), 60);
}

/* ── Cover Upload helpers ────────────────────────────── */
async function uploadCoverFile(file) {
  const fd = new FormData();
  fd.append('cover', file);
  const resp = await fetch('/api/upload/cover', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: fd,
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Upload failed'); }
  return (await resp.json()).url;
}

async function handleCoverUpload(event, ctx) {
  const file = event.target.files[0];
  if (!file) return;
  const msgId   = `cover-upload-msg-${ctx}`;
  const thumbId = `cover-upload-thumb-${ctx}`;
  showMsg(msgId, 'Uploading…', '');
  try {
    const url = await uploadCoverFile(file);
    if (ctx === 'member')     uploadedCoverUrl      = url;
    else if (ctx === 'admin') adminUploadedCoverUrl = url;
    else if (ctx === 'edit')  editCoverUrl          = url;
    else if (ctx === 'medit') memberEditCoverUrl    = url;
    el(thumbId).innerHTML = `<img src="${url}" alt="Cover">`;
    el(thumbId).classList.remove('hidden');
    el(`cover-clear-${ctx}`).classList.remove('hidden');
    showMsg(msgId, 'Uploaded', 'success');
  } catch (e) { showMsg(msgId, e.message, 'error'); }
  event.target.value = '';
}

function clearUploadedCover(ctx) {
  if (ctx === 'member')     uploadedCoverUrl      = null;
  else if (ctx === 'admin') adminUploadedCoverUrl = null;
  else if (ctx === 'edit')  editCoverUrl          = null;
  else if (ctx === 'medit') memberEditCoverUrl    = null;
  el(`cover-upload-thumb-${ctx}`).classList.add('hidden');
  el(`cover-upload-thumb-${ctx}`).innerHTML = '';
  el(`cover-clear-${ctx}`).classList.add('hidden');
  showMsg(`cover-upload-msg-${ctx}`, '', '');
}

function clearPick() {
  pickedBook = null;
  clearUploadedCover('member');
  el('book-title').value = ''; el('book-author').value = '';
  el('book-page-count').value = ''; el('book-year').value = '';
  el('book-description').value = '';
  buildGenreCheckboxes('book-genre-select', '');
  el('book-search').value = '';
  el('book-preview').classList.add('hidden');
}

async function addBook() {
  const title       = el('book-title').value.trim();
  const author      = el('book-author').value.trim();
  const genre       = getGenreValues('book-genre-select');
  const description = el('book-description').value.trim();
  if (!title) return showAddMsg('Please enter a book title.', 'error');
  try {
    const book = await api(`/api/bookclubs/${currentClubId}/books`, 'POST', {
      title, author: author || null,
      cover_url:       uploadedCoverUrl || pickedBook?.cover_url || null,
      open_library_id: pickedBook?.open_library_id || null,
      page_count:      parseInt(el('book-page-count').value) || null,
      release_year:    parseInt(el('book-year').value) || null,
      description:     description || null,
      genre:           genre || null,
    });
    showAddMsg('Book added!', 'success');
    clearPick();
    el('member-add-book-form').classList.add('hidden');
    allBooks.unshift(book);
    populateMemberBookFilters();
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
  ['vote-no-books','vote-no-session','vote-closed-notice','vote-already-voted','vote-not-eligible','vote-area','results-area']
    .forEach(id => el(id).classList.add('hidden'));
  if (!votingSession) { el('vote-no-session').classList.remove('hidden'); return; }
  if (votingSession.is_closed) {
    el('vote-closed-notice').classList.remove('hidden');
    await showPublicResults();
    el('results-area').classList.remove('hidden');
    return;
  }
  const { has_voted, is_eligible } = await api(`/api/bookclubs/${currentClubId}/voting/check-voted`);
  if (!is_eligible) {
    el('vote-not-eligible').classList.remove('hidden');
    if (votingSession.results_visible) {
      await showPublicResults();
      el('results-area').classList.remove('hidden');
    }
    return;
  }
  if (has_voted) {
    el('vote-already-voted').classList.remove('hidden');
    if (votingSession.results_visible) {
      await showPublicResults();
      el('results-area').classList.remove('hidden');
    }
    return;
  }
  if (votingSession.results_visible) {
    await showPublicResults();
    el('results-area').classList.remove('hidden');
  }
  const picks = votingSession.votes_per_member || 2;
  el('vote-pick-count').textContent = picks;
  el('vote-pick-max').textContent   = picks;
  const sessionBookIds = votingSession.session_book_ids || [];
  const eligibleBooks = sessionBookIds.length
    ? allBooks.filter(b => sessionBookIds.includes(b.id) && !b.archived)
    : allBooks.filter(b => b.active_for_voting && !b.selected && !b.archived);
  selectedVoteIds = [];
  el('selected-count').textContent = '0';
  el('submit-vote-btn').disabled = true;
  el('vote-msg').classList.add('hidden');
  renderVoteGrid();
  el('vote-area').classList.remove('hidden');
}

function renderVoteGrid() {
  const sessionBookIds = votingSession?.session_book_ids || [];
  const active = sessionBookIds.length
    ? allBooks.filter(b => sessionBookIds.includes(b.id) && !b.archived)
    : allBooks.filter(b => b.active_for_voting && !b.selected && !b.archived);
  const grid = el('vote-grid');
  if (!active.length) { grid.innerHTML = `<p class="dim">No books available for voting.</p>`; return; }

  let tableRows = '';
  let cardRows  = '';

  active.forEach(b => {
    const img = b.cover_url
      ? `<img class="thumb-sm" src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
      : `<div class="thumb-sm-ph">&#128214;</div>`;
    const imgCell = `<div class="cover-cell">${img}<button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();showBookDetails(${b.id})">Details</button></div>`;
    tableRows += `<tr class="vote-row" data-id="${b.id}" onclick="toggleVoteCard(${b.id})">
      <td class="vote-check-cell"><span class="vote-check-icon">&#10003;</span></td>
      <td>${imgCell}</td>
      <td><strong>${esc(b.title)}</strong></td>
      <td>${esc(b.author || '—')}</td>
      <td>${esc(b.genre  || '—')}</td>
      <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
    </tr>`;

    const cardImg = b.cover_url
      ? `<img class="vc-cover-img" src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
      : `<div class="vc-cover-ph">&#128214;</div>`;
    const metaParts = [
      b.release_year || null,
      b.page_count ? `${Number(b.page_count).toLocaleString()} pp` : null,
      b.genre ? b.genre.split(',')[0].trim() : null,
    ].filter(Boolean);
    const hasSynopsis = !!b.description;
    cardRows += `
      <div class="vote-card vote-row" data-id="${b.id}" onclick="toggleVoteCard(${b.id})">
        <div class="vc-main">
          <div class="vc-check"><span class="vote-check-icon">&#10003;</span></div>
          <div class="vc-cover">
            ${cardImg}
            <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();showBookDetails(${b.id})">Details</button>
          </div>
          <div class="vc-info">
            <div class="vc-title">${esc(b.title)}</div>
            ${b.author ? `<div class="vc-author">${esc(b.author)}</div>` : ''}
            ${metaParts.length ? `<div class="vc-meta">${metaParts.join(' · ')}</div>` : ''}
            ${hasSynopsis ? `<div class="vc-actions"><button class="bc-synopsis-btn" onclick="event.stopPropagation();toggleVoteSynopsis(${b.id},this)">Synopsis ▾</button></div>` : ''}
          </div>
        </div>
        ${hasSynopsis ? `<div id="vc-syn-${b.id}" class="bc-synopsis hidden">${esc(b.description)}</div>` : ''}
      </div>`;
  });

  grid.innerHTML = `
    <div class="table-scroll">
      <table class="vote-table">
        <thead><tr>
          <th style="width:32px"></th>
          <th>Cover</th><th>Title</th><th>Author</th><th>Genre</th><th>Pages</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="vote-cards">${cardRows}</div>`;
}

function toggleVoteSynopsis(id, btn) {
  const syn = document.getElementById(`vc-syn-${id}`);
  if (!syn) return;
  const nowHidden = syn.classList.toggle('hidden');
  btn.textContent = nowHidden ? 'Synopsis ▾' : 'Synopsis ▴';
}

function toggleVoteCard(id) {
  const maxPicks = votingSession?.votes_per_member || 2;
  if (selectedVoteIds.includes(id)) {
    selectedVoteIds = selectedVoteIds.filter(x => x !== id);
  } else if (selectedVoteIds.length < maxPicks) {
    selectedVoteIds.push(id);
  }
  // Sync both table rows and mobile cards (both share .vote-row)
  qsa('.vote-row').forEach(r => {
    const rid = +r.dataset.id;
    r.classList.toggle('chosen', selectedVoteIds.includes(rid));
    r.classList.toggle('locked', !selectedVoteIds.includes(rid) && selectedVoteIds.length >= maxPicks);
  });
  el('selected-count').textContent = selectedVoteIds.length;
  el('submit-vote-btn').disabled = selectedVoteIds.length !== maxPicks;
}

async function submitVote() {
  if (selectedVoteIds.length !== (votingSession?.votes_per_member || 2)) return;
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
  await loadManageNextMeeting(currentClubId);
  await loadManageVoting();
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
          <button class="btn btn-ghost btn-xs" onclick="openEditMember(${u.id},${currentClubId},'manage')">Edit</button>
          ${u.email ? `<button class="btn btn-ghost btn-xs" onclick="resetMemberPassword(${u.id},${currentClubId},'manage',false)">Send Invite</button>` : ''}
          <button class="btn btn-ghost btn-xs" onclick="resetMemberPassword(${u.id},${currentClubId},'manage',true)">Reset Pwd</button>
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

function removeMemberFromManage(userId) {
  const u = clubMembers.find(m => m.id === userId);
  confirmAction(
    'Remove Member',
    `Remove ${u?.name || 'this member'} from the club? This cannot be undone.`,
    async () => {
      try {
        await api(`/api/bookclubs/${currentClubId}/members/${userId}`, 'DELETE');
        await loadManageTab();
      } catch (e) { alert(e.message); }
    }
  );
}

function openEditMember(userId, clubId, ctx) {
  const u = clubMembers.find(x => x.id === userId);
  if (!u) return;
  el('edit-member-user-id').value = userId;
  el('edit-member-club-id').value = clubId;
  el('edit-member-ctx').value     = ctx;
  el('edit-member-name').value    = u.name  || '';
  el('edit-member-email').value   = u.email || '';
  el('edit-member-role').value    = u.club_role || 'member';
  el('edit-member-msg').classList.add('hidden');
  openModal('edit-member-modal');
}

async function resetMemberPassword(userId, clubId, ctx, showModal) {
  const msg = showModal
    ? "Reset this member's password? The new temporary password will be shown."
    : 'Send a new login invite email to this member? This will also reset their password.';
  if (!confirm(msg)) return;
  try {
    const data = await api(`/api/bookclubs/${clubId}/members/${userId}/reset-password`, 'POST');
    if (showModal) {
      const u = clubMembers.find(x => x.id === userId);
      el('pwd-modal-email').textContent = u?.email || '';
      el('pwd-modal-value').textContent = data.temp_password;
      openModal('password-modal');
    } else {
      alert('Invite email sent!');
    }
  } catch (e) { alert(e.message); }
}

async function saveEditMember() {
  const userId = parseInt(el('edit-member-user-id').value);
  const clubId = parseInt(el('edit-member-club-id').value);
  const ctx    = el('edit-member-ctx').value;
  const name   = el('edit-member-name').value.trim();
  const email  = el('edit-member-email').value.trim() || null;
  const role   = el('edit-member-role').value;
  if (!name) return showMsg('edit-member-msg', 'Name is required', 'error');
  try {
    await api(`/api/bookclubs/${clubId}/members/${userId}`, 'PATCH', { name, email });
    await api(`/api/bookclubs/${clubId}/members/${userId}/role`, 'PATCH', { role });
    closeModal('edit-member-modal');
    if (ctx === 'admin') await loadAdminMembers();
    else await loadManageTab();
  } catch (e) { showMsg('edit-member-msg', e.message, 'error'); }
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
  await loadVotingHistory('manage', currentClubId);
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
  showStartSessionForm('manage', currentClubId);
}

/* ── Session config form ─────────────────────────────── */
async function showStartSessionForm(ctx, clubId) {
  const configId = ctx === 'admin' ? 'admin-session-config' : 'manage-session-config';
  const panel = el(configId);
  panel.innerHTML = '<p class="dim">Loading…</p>';
  panel.classList.remove('hidden');
  try {
    const [books, members] = await Promise.all([
      api(`/api/bookclubs/${clubId}/books`).then(bs => bs.filter(b => b.active_for_voting && !b.archived)),
      api(`/api/bookclubs/${clubId}/members`),
    ]);
    if (!books.length) {
      panel.innerHTML = '<p class="dim">No eligible books to include in the ballot.</p>'; return;
    }
    panel.innerHTML = `
      <div class="session-config-inner">
        <div class="field" style="max-width:200px">
          <label>Picks per member</label>
          <input type="number" id="${ctx}-votes-per-member" value="2" min="1" max="${books.length}" class="session-picks-input">
        </div>
        <div class="session-book-list">
          <div class="session-book-list-head">
            <span class="dim" style="font-size:.85rem">Books in ballot</span>
            <div class="action-group">
              <button class="btn btn-ghost btn-xs" onclick="setAllSessionBooks('${ctx}',true)">All</button>
              <button class="btn btn-ghost btn-xs" onclick="setAllSessionBooks('${ctx}',false)">None</button>
            </div>
          </div>
          <div class="table-scroll">
            <table class="session-book-table">
              <thead><tr>
                <th style="width:32px"></th>
                <th>Cover</th><th>Title</th><th>Author</th><th>Genre</th><th>Pages</th>
              </tr></thead>
              <tbody>${books.map(b => {
                const img = b.cover_url
                  ? `<img class="thumb-sm" src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
                  : `<div class="thumb-sm-ph">&#128214;</div>`;
                return `<tr>
                  <td><input type="checkbox" class="session-book-cb" data-ctx="${ctx}" value="${b.id}" checked></td>
                  <td>${img}</td>
                  <td><strong>${esc(b.title)}</strong></td>
                  <td>${esc(b.author || '—')}</td>
                  <td>${esc(b.genre  || '—')}</td>
                  <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        </div>
        <div class="session-book-list">
          <div class="session-book-list-head">
            <span class="dim" style="font-size:.85rem">Eligible voters <span class="dim" style="font-weight:normal">(all members = everyone can vote)</span></span>
            <div class="action-group">
              <button class="btn btn-ghost btn-xs" onclick="setAllSessionVoters('${ctx}',true)">All</button>
              <button class="btn btn-ghost btn-xs" onclick="setAllSessionVoters('${ctx}',false)">None</button>
            </div>
          </div>
          <div class="session-voter-list">
            ${members.map(m => `
              <label class="session-voter-row">
                <input type="checkbox" class="session-voter-cb" data-ctx="${ctx}" value="${m.id}" checked>
                <span>${esc(m.name)}</span>
              </label>`).join('')}
          </div>
        </div>
        <div class="row gap-sm mt-sm">
          <button class="btn btn-primary btn-sm" onclick="submitStartSession('${ctx}',${clubId})">Start Vote</button>
          <button class="btn btn-secondary btn-sm" onclick="cancelStartSession('${ctx}')">Cancel</button>
        </div>
        <p id="${ctx}-start-session-msg" class="msg hidden"></p>
      </div>`;
  } catch { panel.innerHTML = '<p class="dim">Error loading session config.</p>'; }
}

function setAllSessionBooks(ctx, checked) {
  document.querySelectorAll(`.session-book-cb[data-ctx="${ctx}"]`)
    .forEach(cb => cb.checked = checked);
}

function setAllSessionVoters(ctx, checked) {
  document.querySelectorAll(`.session-voter-cb[data-ctx="${ctx}"]`)
    .forEach(cb => cb.checked = checked);
}

function cancelStartSession(ctx) {
  const configId = ctx === 'admin' ? 'admin-session-config' : 'manage-session-config';
  el(configId).classList.add('hidden');
  el(configId).innerHTML = '';
}

async function submitStartSession(ctx, clubId) {
  const n = parseInt(el(`${ctx}-votes-per-member`).value);
  const book_ids = [...document.querySelectorAll(`.session-book-cb[data-ctx="${ctx}"]:checked`)]
    .map(cb => parseInt(cb.value));
  const allVoterCbs = document.querySelectorAll(`.session-voter-cb[data-ctx="${ctx}"]`);
  const checkedVoterCbs = document.querySelectorAll(`.session-voter-cb[data-ctx="${ctx}"]:checked`);
  // Only send voter_ids when a subset is selected (not all or none)
  const voter_ids = checkedVoterCbs.length === allVoterCbs.length
    ? []
    : [...checkedVoterCbs].map(cb => parseInt(cb.value));
  if (!book_ids.length)
    return showMsg(`${ctx}-start-session-msg`, 'Select at least one book', 'error');
  if (book_ids.length < n)
    return showMsg(`${ctx}-start-session-msg`, `Need at least ${n} books for ${n} picks per member`, 'error');
  try {
    const session = await api(`/api/bookclubs/${clubId}/voting/session`, 'POST',
      { votes_per_member: n, book_ids, voter_ids });
    cancelStartSession(ctx);
    if (ctx === 'admin') { votingSession = session; renderAdminVotingPanel(); await loadAdminResults(); await loadVotingHistory('admin', adminClubId); }
    else { manageVotingSession = session; renderManageVotingPanel(); await loadManageResults(); await loadVotingHistory('manage', currentClubId); }
  } catch (e) { showMsg(`${ctx}-start-session-msg`, e.message, 'error'); }
}

async function manageCloseSession() {
  if (!manageVotingSession || !confirm('Close voting and reveal results to all members?')) return;
  try {
    manageVotingSession = await api(`/api/bookclubs/${currentClubId}/voting/session/${manageVotingSession.id}/close`, 'PATCH');
    renderManageVotingPanel();
    await loadManageResults();
  } catch (e) { alert(e.message); }
}

/* ── Voting History ──────────────────────────────────── */
async function loadVotingHistory(ctx, clubId) {
  const listId = ctx === 'admin' ? 'admin-voting-history' : 'manage-voting-history';
  try {
    const sessions = await api(`/api/bookclubs/${clubId}/voting/sessions`);
    renderVotingHistory(sessions, ctx, clubId);
  } catch { el(listId).innerHTML = ''; }
}

function renderVotingHistory(sessions, ctx, clubId) {
  const panel = el(ctx === 'admin' ? 'admin-voting-history' : 'manage-voting-history');
  if (!sessions.length) { panel.innerHTML = ''; return; }
  panel.innerHTML = `<h3 style="color:var(--green);margin-bottom:.65rem">Session History</h3>` +
    sessions.map(s => `
      <div class="session-history-card" id="sh-${ctx}-${s.id}">
        <div class="sh-header">
          <div class="sh-info">
            <span class="sh-date">Started ${fmtDate(s.created_at)}</span>
            ${s.is_closed
              ? `<span class="sh-status dim">Closed ${fmtDate(s.closed_at)} &middot; ${s.voter_count} voter${s.voter_count !== 1 ? 's' : ''}</span>`
              : `<span class="sh-status" style="color:var(--green)">Open &middot; ${s.voter_count} voter${s.voter_count !== 1 ? 's' : ''}</span>`}
            <span class="sh-picks dim">${s.votes_per_member || 2} pick${(s.votes_per_member || 2) !== 1 ? 's' : ''} per voter</span>
          </div>
          <div class="action-group">
            <button class="btn btn-ghost btn-xs" onclick="toggleVoteDetails('${ctx}',${s.id},${clubId},this)">Show Votes</button>
            <button class="btn btn-danger btn-xs" onclick="deleteSessionHistory('${ctx}',${s.id},${clubId})">Delete</button>
          </div>
        </div>
        <div id="sh-votes-${ctx}-${s.id}" class="sh-votes hidden"></div>
      </div>`
    ).join('');
}

async function toggleVoteDetails(ctx, sessionId, clubId, btn) {
  const panel = el(`sh-votes-${ctx}-${sessionId}`);
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden'); btn.textContent = 'Show Votes'; return;
  }
  btn.textContent = 'Loading…';
  try {
    const votes = await api(`/api/bookclubs/${clubId}/voting/sessions/${sessionId}/votes`);
    const canRemove = isSuperAdmin();
    panel.innerHTML = votes.length
      ? `<div style="overflow-x:auto"><table class="sh-votes-table"><thead><tr><th>Member</th><th>Books Chosen</th>${canRemove ? '<th></th>' : ''}</tr></thead><tbody>` +
        votes.map(v => `<tr id="vrow-${v.vote_id}"><td>${esc(v.voter_name)}</td><td>${v.book_titles.map(t => esc(t)).join(', ')}</td>${canRemove ? `<td><button class="btn btn-danger btn-xs" onclick="removeVote('${ctx}',${sessionId},${clubId},${v.vote_id},'${esc(v.voter_name)}',this)">Remove</button></td>` : ''}</tr>`).join('') +
        `</tbody></table></div>`
      : `<p class="dim" style="padding:.5rem 0">No votes recorded.</p>`;
    panel.classList.remove('hidden');
    btn.textContent = 'Hide Votes';
  } catch { btn.textContent = 'Show Votes'; }
}

async function deleteSessionHistory(ctx, sessionId, clubId) {
  if (!confirm('Delete this voting session and all its votes? Cannot be undone.')) return;
  try {
    await api(`/api/bookclubs/${clubId}/voting/sessions/${sessionId}`, 'DELETE');
    el(`sh-${ctx}-${sessionId}`)?.remove();
  } catch (e) { alert(e.message); }
}

async function removeVote(ctx, sessionId, clubId, voteId, voterName, btn) {
  if (!confirm(`Remove ${voterName}'s vote? They will be able to vote again.`)) return;
  btn.disabled = true;
  try {
    await api(`/api/bookclubs/${clubId}/voting/sessions/${sessionId}/votes/${voteId}`, 'DELETE');
    document.getElementById(`vrow-${voteId}`)?.remove();
    if (ctx === 'admin') { await loadAdminResults(); }
    else { await loadManageResults(); }
  } catch (e) { alert(e.message); btn.disabled = false; }
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
async function showAdmin() {
  sessionStorage.removeItem('bc_member_view');
  el('public-home').classList.add('hidden');
  el('login-page').classList.add('hidden');
  el('quick-login-page').classList.add('hidden');
  el('member-app').classList.add('hidden');
  el('admin-app').classList.remove('hidden');
  setupAdminTabs();
  setupAdminListeners();
  await loadAdminClubs();
  loadAnalytics();
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
      if (tab === 'books')     loadAdminBooks();
      if (tab === 'voting')    loadAdminVoting();
      if (tab === 'analytics') loadAnalytics();
      if (tab === 'users')     { loadAdminClubs(); loadAllUsers(); renderGenreManager(); loadAdminManageNm(); loadAdminMembers(); }
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
  buildGenreCheckboxes('admin-book-genre-select', '');
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
  el('admin-nm-set-btn').addEventListener('click', showAdminNmForm);
  el('admin-nm-edit-btn').addEventListener('click', showAdminNmForm);
  el('admin-nm-cancel-btn').addEventListener('click', () => { el('admin-nm-form').classList.add('hidden'); el('admin-nm-msg').className = 'msg hidden'; renderAdminNmDisplay(_adminNmData); });
  el('admin-nm-save-btn').addEventListener('click', saveAdminNextMeeting);
  el('admin-nm-clear-btn').addEventListener('click', clearAdminNextMeeting);
  el('admin-create-session-btn').addEventListener('click', adminCreateSession);
  el('admin-close-session-btn').addEventListener('click', adminCloseSession);
  el('admin-book-filter-text').addEventListener('input', renderAdminBooksTable);
  el('admin-book-filter-submitter').addEventListener('change', renderAdminBooksTable);
  el('admin-book-filter-status').addEventListener('change', renderAdminBooksTable);
  el('analytics-run-btn').addEventListener('click', loadAnalytics);
  el('analytics-from').addEventListener('change', () => applyAnalyticsFilters('admin'));
  el('analytics-to').addEventListener('change', () => applyAnalyticsFilters('admin'));
  el('analytics-member').addEventListener('change', () => applyAnalyticsFilters('admin'));
  el('analytics-status').addEventListener('change', () => applyAnalyticsFilters('admin'));
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

function deleteClub(id) {
  const club = allClubs.find(c => c.id === id);
  if (!club) return;
  confirmAction(
    'Delete Book Club',
    `Delete "${club.name}"? A club can only be deleted if it has no members and no books. This cannot be undone.`,
    async () => {
      try {
        await api(`/api/bookclubs/${id}`, 'DELETE');
        allClubs = allClubs.filter(c => c.id !== id);
        populateAdminClubSelect();
        renderClubsGrid();
        el('clubs-msg').classList.add('hidden');
      } catch (e) { showMsg('clubs-msg', e.message, 'error'); }
    }
  );
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
          <button class="btn btn-ghost btn-xs" onclick="openEditMember(${u.id},${adminClubId},'admin')">Edit</button>
          ${u.email ? `<button class="btn btn-ghost btn-xs" onclick="resetMemberPassword(${u.id},${adminClubId},'admin',false)">Send Invite</button>` : ''}
          <button class="btn btn-ghost btn-xs" onclick="resetMemberPassword(${u.id},${adminClubId},'admin',true)">Reset Pwd</button>
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

function removeMember(userId) {
  confirmAction(
    'Remove Member',
    'Remove this member from the club? This cannot be undone.',
    async () => {
      try {
        await api(`/api/bookclubs/${adminClubId}/members/${userId}`, 'DELETE');
        await loadAdminMembers();
      } catch (e) { alert(e.message); }
    }
  );
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
    populateAdminBookFilters();
    renderAdminBooksTable();
    populateSubmitterSelect('admin-book-submitter');
    populateSubmitterSelect('edit-submitter');
  } catch(e) { console.error(e); }
}

function populateSubmitterSelect(selectId) {
  const sel = el(selectId);
  sel.innerHTML = [`<option value="">— select member —</option>`, ...clubMembers.map(u => `<option value="${u.id}" data-name="${esc(u.name)}">${esc(u.name)}</option>`)].join('');
}

function populateAdminBookFilters() {
  const sel = el('admin-book-filter-submitter');
  if (!sel) return;
  const seen = new Map();
  for (const b of allBooks) {
    if (b.added_by_user_id && !seen.has(b.added_by_user_id))
      seen.set(b.added_by_user_id, b.added_by_name || '?');
  }
  const current = sel.value;
  sel.innerHTML = `<option value="">All members</option>` +
    [...seen.entries()].sort((a,b)=>a[1].localeCompare(b[1]))
      .map(([id, name]) => `<option value="${id}"${String(id)===current?' selected':''}>${esc(name)}</option>`).join('');
}

function renderAdminBooksTable() {
  const tbody     = el('admin-books-tbody');
  const cards     = el('admin-books-cards');
  const q         = (el('admin-book-filter-text')?.value || '').trim().toLowerCase();
  const submitter = el('admin-book-filter-submitter')?.value || '';
  const status    = el('admin-book-filter-status')?.value  || '';

  let books = [...allBooks];
  if (q)         books = books.filter(b =>
    b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q));
  if (submitter) books = books.filter(b => String(b.added_by_user_id) === submitter);
  if (status === 'voting')   books = books.filter(b => b.active_for_voting && !b.selected && !b.archived);
  if (status === 'selected') books = books.filter(b => b.selected);

  if (!books.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-state">${allBooks.length ? 'No books match the current filter.' : 'No books yet.'}</td></tr>`;
    if (cards) cards.innerHTML = '';
    return;
  }
  let tableRows = '';
  let cardRows  = '';
  books.forEach(b => {
    const cover = b.cover_url
      ? `<img class="thumb" src="${b.cover_url}" alt="" onerror="this.outerHTML='<div class=thumb-ph>&#128214;</div>'">`
      : `<div class="thumb-ph">&#128214;</div>`;
    const badge = b.archived
      ? `<span class="badge badge-removed">Archived</span>`
      : b.selected
        ? `<span class="badge badge-selected">&#10003; Selected</span>`
        : `<span class="badge badge-active">Active</span>`;
    const canToggleVoting = !b.archived;
    const votingCb = `<input type="checkbox" class="voting-cb" ${b.active_for_voting ? 'checked' : ''} ${canToggleVoting ? '' : 'disabled'}
      title="${b.archived ? 'Book is archived' : 'Toggle voting eligibility'}"
      onchange="adminToggleVoting(${b.id})">`;
    const archiveBtn = !b.selected
      ? (b.archived
          ? `<button class="btn btn-ghost btn-xs" onclick="adminArchiveBook(${b.id},false)">Unarchive</button>`
          : `<button class="btn btn-ghost btn-xs" onclick="adminArchiveBook(${b.id},true)">Archive</button>`)
      : '';

    // ── Desktop table row ──
    tableRows += `<tr class="${b.archived ? 'inactive' : ''}">
      <td><div class="cover-cell">${cover}<button class="btn btn-ghost btn-xs" onclick="showAdminBookDetails(${b.id})">Details</button></div></td>
      <td><strong>${esc(b.title)}</strong></td>
      <td>${esc(b.author || '—')}</td>
      <td>${esc(b.genre  || '—')}</td>
      <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
      <td>${b.release_year || '—'}</td>
      <td>${esc(b.added_by_name || '—')}</td>
      <td>${fmtDate(b.submitted_at || b.added_at)}</td>
      <td class="td-voting">${votingCb}</td>
      <td>${badge}</td>
      <td>${b.selected_at ? fmtDate(b.selected_at) : '—'}</td>
      <td><div class="action-group">
        <button class="btn btn-ghost btn-xs" onclick="openEditBook(${b.id})">Edit</button>
        ${archiveBtn}
        <button class="btn btn-danger btn-xs" onclick="adminDeleteBook(${b.id})">Delete</button>
      </div></td>
    </tr>`;

    // ── Mobile card ──
    const coverCard = b.cover_url
      ? `<img class="bc-cover-img" src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
      : `<div class="bc-cover-ph">&#128214;</div>`;
    const metaParts = [
      b.release_year || null,
      b.page_count ? `${Number(b.page_count).toLocaleString()} pp` : null,
      b.genre ? b.genre.split(',')[0].trim() : null,
    ].filter(Boolean);
    const hasSynopsis = !!b.description;
    const votingCardCb = `<input type="checkbox" class="voting-cb" ${b.active_for_voting ? 'checked' : ''} ${canToggleVoting ? '' : 'disabled'}
      title="${b.archived ? 'Book is archived' : 'Toggle voting'}"
      onchange="adminToggleVoting(${b.id})">`;
    const actionBtns = [
      `<button class="btn btn-ghost btn-xs" onclick="openEditBook(${b.id})">Edit</button>`,
      archiveBtn,
      `<button class="btn btn-danger btn-xs" onclick="adminDeleteBook(${b.id})">Delete</button>`,
    ].filter(Boolean).join('');
    cardRows += `
      <div class="book-card ${b.archived ? 'book-card-inactive' : ''}" id="adn-bc-${b.id}">
        <div class="bc-main">
          <div class="bc-cover">${coverCard}<button class="btn btn-ghost btn-xs" onclick="showAdminBookDetails(${b.id})">Details</button></div>
          <div class="bc-info">
            <div class="bc-title">${esc(b.title)}</div>
            ${b.author ? `<div class="bc-author">${esc(b.author)}</div>` : ''}
            ${metaParts.length ? `<div class="bc-meta">${metaParts.join(' · ')}</div>` : ''}
            <div class="bc-badges">${badge} ${votingCardCb}</div>
            <div class="bc-submitted">By ${esc(b.added_by_name || '?')} · ${fmtDate(b.submitted_at || b.added_at)}</div>
            <div class="bc-actions">${actionBtns}</div>
            ${hasSynopsis ? `<button class="bc-synopsis-btn" onclick="adminToggleSynopsis(${b.id},this)">View Synopsis ▾</button>` : ''}
          </div>
        </div>
        ${hasSynopsis ? `<div id="adn-syn-${b.id}" class="bc-synopsis hidden">${esc(b.description)}</div>` : ''}
      </div>`;
  });
  tbody.innerHTML = tableRows;
  if (cards) cards.innerHTML = cardRows;
}

function adminToggleSynopsis(id, btn) {
  const syn = document.getElementById(`adn-syn-${id}`);
  if (!syn) return;
  const nowHidden = syn.classList.toggle('hidden');
  btn.textContent = nowHidden ? 'View Synopsis ▾' : 'Hide Synopsis ▴';
}

async function adminToggleVoting(id) {
  try {
    const updated = await api(`/api/bookclubs/${adminClubId}/books/${id}/toggle-voting`, 'PATCH', {});
    const idx = allBooks.findIndex(b => b.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    renderAdminBooksTable();
  } catch (e) { alert(e.message); }
}

async function adminArchiveBook(id, archive) {
  try {
    const updated = await api(`/api/bookclubs/${adminClubId}/books/${id}/archive`, 'PATCH', { archived: archive });
    const idx = allBooks.findIndex(b => b.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    renderAdminBooksTable();
  } catch (e) { alert(e.message); }
}

async function adminPickBook(i) {
  adminPickedBook = window._searchResults[i];
  hideDropdown('admin-search-dropdown');
  el('admin-book-search').value       = '';
  el('admin-book-title').value        = adminPickedBook.title;
  el('admin-book-author').value       = adminPickedBook.author;
  el('admin-book-page-count').value   = adminPickedBook.page_count || '';
  el('admin-book-year').value         = adminPickedBook.release_year || '';
  el('admin-book-description').value  = '';
  el('admin-preview-title').textContent  = adminPickedBook.title;
  el('admin-preview-author').textContent = adminPickedBook.author;
  const adminPageParts = [adminPickedBook.page_count ? `${adminPickedBook.page_count} pages` : '', adminPickedBook.release_year || ''].filter(Boolean);
  el('admin-preview-pages').textContent  = adminPageParts.join(' · ');
  el('admin-preview-genre').textContent  = '';
  el('admin-preview-desc').textContent   = '';
  const img = el('admin-preview-img');
  img.src = adminPickedBook.cover_url || ''; img.style.display = adminPickedBook.cover_url ? 'block' : 'none';
  el('admin-book-preview').classList.remove('hidden');
  if (adminPickedBook.open_library_id) {
    try {
      const info = await api(`/api/book-info?key=${encodeURIComponent(adminPickedBook.open_library_id)}`);
      adminPickedBook.description = info.description || null;
      el('admin-preview-desc').textContent = info.description || '';
      el('admin-book-description').value   = info.description || '';
    } catch {}
  }
}

function adminClearPick() {
  adminPickedBook = null;
  clearUploadedCover('admin');
  ['admin-book-title','admin-book-author','admin-book-page-count','admin-book-year','admin-book-description','admin-book-search'].forEach(id => el(id).value = '');
  buildGenreCheckboxes('admin-book-genre-select', '');
  el('admin-book-preview').classList.add('hidden');
}

async function adminAddBook() {
  const title        = el('admin-book-title').value.trim();
  const author       = el('admin-book-author').value.trim();
  const genre        = getGenreValues('admin-book-genre-select');
  const description  = el('admin-book-description').value.trim();
  const submitterSel = el('admin-book-submitter');
  const submitterId  = parseInt(submitterSel.value) || null;
  const submitterName= submitterId ? submitterSel.selectedOptions[0]?.dataset.name : null;
  const submittedAt  = el('admin-book-submitted-at').value || null;
  const selectedAt   = el('admin-book-selected-at').value  || null;
  if (!title) return showMsg('admin-add-book-msg', 'Title required', 'error');
  try {
    const book = await api(`/api/bookclubs/${adminClubId}/books`, 'POST', {
      title, author: author || null, genre: genre || null,
      cover_url:       adminUploadedCoverUrl || adminPickedBook?.cover_url || null,
      open_library_id: adminPickedBook?.open_library_id || null,
      page_count:      parseInt(el('admin-book-page-count').value) || adminPickedBook?.page_count || null,
      release_year:    parseInt(el('admin-book-year').value) || null,
      description:     description || null,
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
  buildGenreCheckboxes('edit-genre-select', b.genre || '');
  el('edit-submitted-at').value   = b.submitted_at ? b.submitted_at.slice(0,10) : '';
  el('edit-selected-at').value    = b.selected_at  ? b.selected_at.slice(0,10)  : '';
  el('edit-page-count').value     = b.page_count || '';
  el('edit-year').value           = b.release_year || '';
  el('edit-description').value    = b.description || '';
  const editVotingCb = el('edit-active-voting');
  editVotingCb.checked  = !!b.active_for_voting;
  editVotingCb.disabled = !!b.archived;
  populateSubmitterSelect('edit-submitter');
  if (b.added_by_user_id) el('edit-submitter').value = b.added_by_user_id;
  openModal('edit-book-modal');
  // Reset cover upload state
  editCoverUrl = null;
  el('cover-upload-thumb-edit').innerHTML = b.cover_url
    ? `<img src="${b.cover_url}" alt="Cover">` : '';
  el('cover-upload-thumb-edit').classList.toggle('hidden', !b.cover_url);
  el('cover-clear-edit').classList.add('hidden');
  showMsg('cover-upload-msg-edit', '', '');
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
      genre:            getGenreValues('edit-genre-select'),
      page_count:       parseInt(el('edit-page-count').value) || null,
      release_year:     parseInt(el('edit-year').value) || null,
      description:      el('edit-description').value.trim() || null,
      active_for_voting: el('edit-active-voting').checked,
      submitted_at:     el('edit-submitted-at').value ? new Date(el('edit-submitted-at').value).toISOString() : null,
      selected:         !!selectedAt,
      selected_at:      selectedAt ? new Date(selectedAt).toISOString() : null,
      added_by_user_id: submitterId,
      added_by_name:    submitterId ? submitterName : null,
      ...(editCoverUrl !== null && { cover_url: editCoverUrl }),
    });
    const idx = allBooks.findIndex(x => x.id === id);
    if (idx !== -1) allBooks[idx] = updated;
    if (_editClubId === currentClubId) renderBooksTable();
    else renderAdminBooksTable();
    _editClubId = null;
    closeModal('edit-book-modal');
  } catch (e) { showMsg('edit-book-msg', e.message, 'error'); }
}

function adminDeleteBook(id) {
  const b = allBooks.find(x => x.id === id);
  const msg = b?.selected
    ? `Permanently delete "${b?.title || 'this book'}"? This book was already selected (read) and cannot be recovered.`
    : `Permanently delete "${b?.title || 'this book'}"? This cannot be undone.`;
  confirmAction(
    'Delete Book',
    msg,
    async () => {
      try {
        await api(`/api/bookclubs/${adminClubId}/books/${id}`, 'DELETE');
        allBooks = allBooks.filter(b => b.id !== id);
        renderAdminBooksTable();
      } catch (e) { alert(e.message); }
    }
  );
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
  await loadVotingHistory('admin', adminClubId);
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
    if (isSuperAdmin()) {
      const toggleBtn = document.getElementById('admin-toggle-results-btn') || (() => {
        const b = document.createElement('button');
        b.id = 'admin-toggle-results-btn';
        b.className = 'btn btn-ghost btn-sm';
        closeBtn.parentNode.insertBefore(b, closeBtn.nextSibling);
        return b;
      })();
      const vis = !!votingSession.results_visible;
      toggleBtn.textContent = vis ? 'Hide Results from Members' : 'Show Live Results to All';
      toggleBtn.className   = vis ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm';
      toggleBtn.onclick     = adminToggleResults;
    }
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
  showStartSessionForm('admin', adminClubId);
}

async function adminCloseSession() {
  if (!votingSession || !confirm('Close voting and reveal results to all members?')) return;
  try {
    votingSession = await api(`/api/bookclubs/${adminClubId}/voting/session/${votingSession.id}/close`, 'PATCH');
    document.getElementById('admin-toggle-results-btn')?.remove();
    renderAdminVotingPanel();
    await loadAdminResults();
  } catch (e) { alert(e.message); }
}

async function adminToggleResults() {
  if (!votingSession) return;
  const newVisible = !votingSession.results_visible;
  try {
    votingSession = await api(`/api/bookclubs/${adminClubId}/voting/session/${votingSession.id}/toggle-results`, 'PATCH', { visible: newVisible });
    renderAdminVotingPanel();
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

function deleteUser(id) {
  const u = allUsers.find(x => x.id === id);
  confirmAction(
    'Delete User',
    `Permanently delete "${u?.name || 'this user'}"? This cannot be undone.`,
    async () => {
      try {
        await api(`/api/users/${id}`, 'DELETE');
        await loadAllUsers();
      } catch (e) { alert(e.message); }
    }
  );
}

/* ── Admin: Genre Manager (superadmin) ──────────────── */
function renderGenreManager() {
  const panel = el('genre-manager');
  if (!panel) return;
  const list = genreListFull.length ? genreListFull : [];
  panel.innerHTML = list.length
    ? list.map(g => `
      <div class="genre-manage-row" id="genre-row-${g.id}">
        <span class="genre-manage-name" id="genre-name-${g.id}">${esc(g.name)}</span>
        <div class="action-group">
          <button class="btn btn-ghost btn-xs" onclick="startRenameGenre(${g.id})">Rename</button>
          <button class="btn btn-danger btn-xs" onclick="confirmDeleteGenre(${g.id}, '${esc(g.name).replace(/'/g,"\\'")}')">Delete</button>
        </div>
      </div>`).join('')
    : `<p class="dim" style="padding:.5rem 0">No genres yet.</p>`;
}

function showAddGenreForm() {
  el('add-genre-form').classList.remove('hidden');
  el('new-genre-name').focus();
}

function hideAddGenreForm() {
  el('add-genre-form').classList.add('hidden');
  el('new-genre-name').value = '';
  el('add-genre-msg').classList.add('hidden');
}

async function submitAddGenre() {
  const name = el('new-genre-name').value.trim();
  if (!name) return showMsg('add-genre-msg', 'Enter a genre name', 'error');
  try {
    const g = await api('/api/genres', 'POST', { name });
    genreListFull = [...genreListFull, g].sort((a, b) => a.name.localeCompare(b.name));
    genreList = genreListFull.map(x => x.name);
    hideAddGenreForm();
    renderGenreManager();
  } catch (e) { showMsg('add-genre-msg', e.message, 'error'); }
}

function startRenameGenre(id) {
  const g = genreListFull.find(x => x.id === id);
  if (!g) return;
  const nameEl = el(`genre-name-${id}`);
  nameEl.outerHTML = `<input type="text" id="genre-rename-input-${id}" class="genre-rename-input" value="${esc(g.name)}" onkeydown="if(event.key==='Enter')submitRenameGenre(${id});if(event.key==='Escape')renderGenreManager();">`;
  el(`genre-rename-input-${id}`).select();
  // Replace action buttons with Save/Cancel
  const row = el(`genre-row-${id}`);
  const actions = row.querySelector('.action-group');
  actions.innerHTML = `
    <button class="btn btn-primary btn-xs" onclick="submitRenameGenre(${id})">Save</button>
    <button class="btn btn-ghost btn-xs" onclick="renderGenreManager()">Cancel</button>`;
}

async function submitRenameGenre(id) {
  const input = el(`genre-rename-input-${id}`);
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  try {
    const g = await api(`/api/genres/${id}`, 'PATCH', { name });
    const idx = genreListFull.findIndex(x => x.id === id);
    if (idx !== -1) genreListFull[idx] = g;
    genreListFull.sort((a, b) => a.name.localeCompare(b.name));
    genreList = genreListFull.map(x => x.name);
    renderGenreManager();
  } catch (e) { alert(e.message); }
}

function confirmDeleteGenre(id, name) {
  confirmAction(
    'Delete Genre',
    `Delete genre "${name}"? Books that use this genre will keep the value but it won't appear in new pickers.`,
    async () => {
      try {
        await api(`/api/genres/${id}`, 'DELETE');
        genreListFull = genreListFull.filter(x => x.id !== id);
        genreList = genreListFull.map(x => x.name);
        renderGenreManager();
      } catch (e) { alert(e.message); }
    }
  );
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
    if (b.genre) {
      for (const g of b.genre.split(',').map(s => s.trim()).filter(Boolean))
        genreMap[g] = (genreMap[g] || 0) + 1;
    }
  }
  const genres = Object.entries(genreMap).sort((a,b) => b[1]-a[1]);
  const total_pages_read = selected.reduce((s, b) => s + (b.page_count ? Number(b.page_count) : 0), 0);
  const by_month = {};
  const by_year  = {};
  for (const b of selected) {
    if (b.selected_at) {
      const date  = new Date(b.selected_at);
      const m     = (date.getUTCMonth() + 1).toString().padStart(2, '0'); // '01'-'12'
      const y     = date.getUTCFullYear().toString();
      const pages = b.page_count ? Number(b.page_count) : 0;
      if (!by_month[m]) by_month[m] = { books: 0, pages: 0 };
      by_month[m].books++;
      by_month[m].pages += pages;
      if (!by_year[y]) by_year[y] = { books: 0, pages: 0 };
      by_year[y].books++;
      by_year[y].pages += pages;
    }
  }
  const withPages = books.filter(b => b.page_count);
  const avg_page_count = withPages.length
    ? Math.round(withPages.reduce((s,b)=>s+Number(b.page_count),0)/withPages.length) : null;

  // Average days between consecutive selected books (by selected_at date)
  const readDated = selected.filter(b => b.selected_at)
    .sort((a, b) => new Date(a.selected_at) - new Date(b.selected_at));
  let avg_days_between = null;
  if (readDated.length >= 2) {
    const diffs = [];
    for (let i = 1; i < readDated.length; i++) {
      diffs.push((new Date(readDated[i].selected_at) - new Date(readDated[i-1].selected_at)) / 86400000);
    }
    avg_days_between = Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length);
  }

  return { total_submitted:books.length, total_read:selected.length, total_pages_read,
           total_members:members.length, avg_page_count, avg_days_between, by_user, genres, by_month, by_year };
}

async function loadAnalyticsCtx(ctx) {
  const clubId    = ctx === 'admin' ? adminClubId : currentClubId;
  const contentId = _aCtxId(ctx, 'analytics-content', 'manage-analytics-content', 'stats-content');
  if (!clubId) return;
  if (ctx === 'admin') {
    const club = allClubs.find(c => c.id === clubId);
    el('analytics-club-label').textContent = club ? `— ${club.name}` : '';
  } else if (ctx === 'stats') {
    const club = allClubs.find(c => c.id === clubId);
    el('stats-club-label').textContent = club ? `— ${club.name}` : '';
  }
  el(contentId).innerHTML = `<p class="dim text-center mt-sm">Loading…</p>`;
  try {
    [_aState[ctx].books, _aState[ctx].members] = await Promise.all([
      api(`/api/bookclubs/${clubId}/books`),
      api(`/api/bookclubs/${clubId}/members`),
    ]);
    populateAnalyticsMemberFilter(ctx);
    applyAnalyticsFilters(ctx);
  } catch { el(contentId).innerHTML = `<p class="dim">Error loading stats.</p>`; }
}

async function loadAnalytics() {
  await loadAnalyticsCtx('admin');
  await loadAdminNextMeeting();
}
function loadManageAnalytics() { return loadAnalyticsCtx('manage'); }
function loadMemberStats()     { return loadAnalyticsCtx('stats'); }

function populateAnalyticsMemberFilter(ctx) {
  const filterId = _aCtxId(ctx, 'analytics-member', 'manage-analytics-member', 'stats-member');
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
  const fromEl   = _aCtxId(ctx, 'analytics-from',   'manage-analytics-from',   'stats-from');
  const toEl     = _aCtxId(ctx, 'analytics-to',     'manage-analytics-to',     'stats-to');
  const memberEl = _aCtxId(ctx, 'analytics-member', 'manage-analytics-member', 'stats-member');

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
  const contentId   = _aCtxId(ctx, 'analytics-content', 'manage-analytics-content', 'stats-content');
  const maxByUser   = Math.max(...d.by_user.map(u => u.submitted), 1);
  const maxGenre    = d.genres.length ? d.genres[0][1] : 1;
  const monthEntries = Object.entries(d.by_month).sort();
  const yearEntries  = Object.entries(d.by_year).sort();

  const fmtPill = (v) =>
    `${v.books} book${v.books !== 1 ? 's' : ''}${v.pages > 0 ? ' · ' + v.pages.toLocaleString() + ' pg' : ''}`;

  el(contentId).innerHTML = `
    <div class="stat-cards">
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','all')" title="Click to see these books">
        <div class="stat-value">${d.total_submitted}</div><div class="stat-label">Books Submitted</div></div>
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','selected')" title="Click to see these books">
        <div class="stat-value">${d.total_read}</div><div class="stat-label">Books Read</div></div>
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','pages-read')" title="Click to see books read">
        <div class="stat-value">${d.total_pages_read > 0 ? d.total_pages_read.toLocaleString() : '—'}</div><div class="stat-label">Pages Read</div></div>
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','members')" title="Click to see members">
        <div class="stat-value">${d.total_members}</div><div class="stat-label">Members</div></div>
      <div class="stat-card clickable" onclick="showAnalyticsDrilldown('${ctx}','pages')" title="Click to see books by page count">
        <div class="stat-value">${d.avg_page_count ?? '—'}</div><div class="stat-label">Avg Pages</div></div>
      <div class="stat-card" title="Average days between books being selected in this timeframe">
        <div class="stat-value">${d.avg_days_between ?? '—'}</div><div class="stat-label">Avg Days Between Reads</div></div>
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
    ${yearEntries.length ? `<div class="analytics-section"><h3>Books Read by Year</h3>
      <div class="month-grid">${yearEntries.map(([y, v]) =>
        `<div class="month-pill clickable" onclick="showAnalyticsDrilldown('${ctx}','year','${y}')" title="Click to see these books">
          ${y} &nbsp;&#x2022;&nbsp; ${fmtPill(v)}</div>`).join('')}
      </div></div>` : ''}
    ${monthEntries.length ? `<div class="analytics-section"><h3>Books Read by Month</h3>
      <div class="month-grid">${monthEntries.map(([k, v]) => {
        const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const label = MONTH_ABBR[parseInt(k)-1] || k;
        return `<div class="month-pill clickable" onclick="showAnalyticsDrilldown('${ctx}','month','${k}')" title="Click to see these books">
          ${label} &nbsp;&#x2022;&nbsp; ${fmtPill(v)}</div>`;
      }).join('')}
      </div></div>` : ''}
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
    case 'genre': books = f.filter(b=>b.genre?.split(',').map(s=>s.trim()).includes(value)); title = `Genre: ${value}`; break;
    case 'month': {
      const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const mLabel = MONTH_ABBR[parseInt(value)-1] || value;
      books = f.filter(b => b.selected && b.selected_at?.slice(5,7) === value);
      title = `Read in ${mLabel}`; break;
    }
    case 'year':  books = f.filter(b=>b.selected && b.selected_at?.slice(0,4)===String(value));
                                                                                title = `Books Read in ${value}`; break;
    case 'pages-read': books = [...f].filter(b=>b.selected && b.page_count)
                         .sort((a,b)=>Number(b.page_count)-Number(a.page_count));
                                                                                title = 'Books Read (by Pages)'; break;
    default: return;
  }
  renderDrilldownBooks(ctx, title, books);
}

function renderDrilldownBooks(ctx, title, books) {
  const panelId = _aCtxId(ctx, 'analytics-drilldown', 'manage-analytics-drilldown', 'stats-drilldown');
  const panel   = el(panelId);
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="drilldown-head">
      <h4>${esc(title)} <span class="dim">(${books.length})</span></h4>
      <button class="btn btn-ghost btn-sm" onclick="closeAnalyticsDrilldown('${ctx}')">&#x2715; Close</button>
    </div>
    <div class="drilldown-body">
      ${books.length
        ? `<div class="table-scroll"><table class="drilldown-table">
            <thead><tr>
              <th>Cover</th><th>Title</th><th>Author</th><th>Genre</th><th>Pages</th><th>Submitted By</th><th>Date</th><th>Status</th>
            </tr></thead>
            <tbody>${books.map(b => {
              const cover = b.cover_url
                ? `<img class="thumb-sm" src="${b.cover_url}" alt="" onerror="this.style.display='none'">`
                : `<div class="thumb-sm-ph">&#128214;</div>`;
              const selBadge = b.selected
                ? `<span class="badge badge-selected" style="font-size:.7rem">&#10003; Selected</span>`
                : `<span class="badge badge-active" style="font-size:.7rem">Active</span>`;
              return `<tr>
                <td><div class="cover-cell">${cover}<button class="btn btn-ghost btn-xs" onclick="showDrilldownBookDetails(${b.id},'${ctx}')">Details</button></div></td>
                <td><strong>${esc(b.title)}</strong></td>
                <td>${esc(b.author || '—')}</td>
                <td>${esc(b.genre  || '—')}</td>
                <td>${b.page_count ? Number(b.page_count).toLocaleString() : '—'}</td>
                <td>${esc(b.added_by_name || '—')}</td>
                <td>${fmtDate(b.submitted_at||b.added_at)}</td>
                <td>${selBadge}</td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`
        : `<p class="dim" style="padding:.75rem 0">No books.</p>`}
    </div>`;
  panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function renderDrilldownMembers(ctx) {
  const panelId = _aCtxId(ctx, 'analytics-drilldown', 'manage-analytics-drilldown', 'stats-drilldown');
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
  const id = _aCtxId(ctx, 'analytics-drilldown', 'manage-analytics-drilldown', 'stats-drilldown');
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
