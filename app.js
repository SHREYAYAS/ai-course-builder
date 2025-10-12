// --- PHASE 5: FIRESTORE INTEGRATION ---

// This event listener waits for the HTML document to be fully loaded.
document.addEventListener('DOMContentLoaded', () => {

    // Compute API base so it works when opening index.html directly (file://)
    const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : '';

    // Parse start view from URL (e.g., /?view=dashboard)
    let START_VIEW = null;
    try {
        const params = new URLSearchParams(location.search);
        const v = (params.get('view') || '').toLowerCase();
        if (v === 'dashboard') START_VIEW = 'dashboard';
    } catch (_) {}

    // Quick backend ping to help users see if server is up
    (async () => {
        try {
            const r = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
            if (!r.ok) throw new Error(`Health status ${r.status}`);
            const j = await r.json();
            console.log('Backend health:', j);
            // Update YouTube banner if enrichment is disabled, key missing, or in backoff
            try {
                const banner = document.getElementById('yt-banner');
                const yt = j.youtube || {};
                const backoffActive = yt.backoffUntil && Date.now() < yt.backoffUntil;
                const noKey = j && j.youtubeKeyLoaded === false;
                const disabled = yt && yt.enrichEnabled === false;
                if (banner && (disabled || backoffActive || noKey)) {
                    const when = backoffActive ? ` until ${new Date(yt.backoffUntil).toLocaleTimeString()}` : '';
                    const msg = noKey
                        ? 'Videos are disabled on this deployment (no YouTube API key configured).'
                        : disabled
                            ? 'Videos are disabled on this deployment (YT_ENRICH=false). Enable YT_ENRICH or remove it to restore video search.'
                            : 'Some lessons may not include videos right now due to YouTube API limits' + when + '.';
                    banner.textContent = msg;
                    banner.classList.remove('hidden');
                }
            } catch (_) {}
        } catch (e) {
            console.warn('Backend not reachable at', `${API_BASE}/health`);
        }
    })();

    // --- 1. FIREBASE INITIALIZATION ---
    // Guard: if Firebase scripts aren’t loaded, continue without auth
    let db = null;
    let auth = null;
    try {
        if (window.firebase && firebase.initializeApp) {
            const firebaseConfig = {
                apiKey: "AIzaSyA6sBsV-UoWuO5Fbw4amyR3BPNTpNYopJk",
                authDomain: "ai-course-builder-f6984.firebaseapp.com",
                projectId: "ai-course-builder-f6984",
                storageBucket: "ai-course-builder-f6984.firebasestorage.app",
                messagingSenderId: "679549148659",
                appId: "1:679549148659:web:da0f08b018abc242370686",
                measurementId: "G-B3HZLW52MT"
            };
            firebase.initializeApp(firebaseConfig);
            db = firebase.firestore();
            // Networking resilience: avoid QUIC issues and use long-polling when needed
            try {
                db.settings({ experimentalAutoDetectLongPolling: true, useFetchStreams: false });
            } catch (e) {
                console.warn('Firestore settings apply failed (non-fatal):', e);
            }
            // Offline cache so data survives refresh even with flaky network
            try {
                if (firebase.firestore && typeof firebase.firestore().enablePersistence === 'function') {
                    firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch((err) => {
                        console.warn('Firestore persistence not enabled:', err && err.code || err);
                    });
                }
            } catch (e) {
                console.warn('Firestore persistence apply failed:', e);
            }
            auth = firebase.auth();
        } else {
            console.warn('Firebase scripts not found. Proceeding without auth/Firestore.');
        }
    } catch (e) {
        console.warn('Firebase init failed. Proceeding without auth/Firestore.', e);
    }

    // --- 2. APP STATE & DOM REFERENCES ---
    const appState = {
        currentView: 'generator',
        currentCourse: null,
        user: null, // Firebase user when signed in
        timer: {
            intervalId: null,
            timeLeft: 25 * 60,
            isRunning: false,
            defaultTime: 25 * 60,
        },
        forcedStartView: START_VIEW
    };

    // LocalStorage helpers (fallback persistence when no auth/DB)
    const LS_KEYS = {
        lastCourse: 'intelli:lastCourse',
        lastUserId: 'intelli:lastUserId',
        timer: 'intelli:timer',
        streak: 'intelli:streak',
        study: 'intelli:study'
    };
    const saveToLocal = (key, value) => {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
    };
    const loadFromLocal = (key) => {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    };

    // --- Toast system ---
    function ensureToastContainer() {
        let c = document.getElementById('toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'toast-container';
            c.className = 'toast-container';
            document.body.appendChild(c);
        }
        return c;
    }
    function showToast({ title = 'Nice!', text = '', icon = '🔥', timeout = 3500 } = {}) {
        const container = ensureToastContainer();
        const el = document.createElement('div');
        el.className = 'toast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML = `
            <span class="toast-icon" aria-hidden="true">${icon}</span>
            <span class="toast-title">${title}</span>
            <span class="toast-text">${text}</span>
            <button class="toast-close" aria-label="Dismiss">×</button>
        `;
        const closeBtn = el.querySelector('.toast-close');
        const remove = () => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 250);
        };
        closeBtn.addEventListener('click', remove);
        container.appendChild(el);
        // animate in
        requestAnimationFrame(() => el.classList.add('show'));
        if (timeout > 0) setTimeout(remove, timeout);
        return el;
    }

    // --- Study Hours (Today) helpers ---
    function getStudyState() {
        const data = loadFromLocal(LS_KEYS.study) || {};
        const key = todayKey();
        const sec = typeof data[key] === 'number' ? data[key] : 0;
        return { map: data, key, sec };
    }

    function setStudySecondsForToday(seconds) {
        const s = getStudyState();
        s.map[s.key] = Math.max(0, Math.floor(seconds));
        saveToLocal(LS_KEYS.study, s.map);
        updateStudyHoursUI(s.map[s.key]);
    }

    function addStudySeconds(delta = 1) {
        const s = getStudyState();
        s.map[s.key] = Math.max(0, Math.floor((s.map[s.key] || 0) + delta));
        saveToLocal(LS_KEYS.study, s.map);
        updateStudyHoursUI(s.map[s.key]);
    }

    function formatHours(minsFloat) {
        if (minsFloat >= 60) {
            const h = minsFloat / 60;
            return `${h.toFixed(1)}h`;
        }
        return `${Math.round(minsFloat)}m`;
    }

    function updateStudyHoursUI(seconds) {
        const el = document.getElementById('study-hours');
        if (!el) return;
        const mins = seconds / 60;
        el.textContent = formatHours(mins);
        const exact = Math.round(mins);
        el.title = `${exact} minutes today`;
        el.setAttribute('aria-label', `${exact} minutes today`);
        // Also refresh weekly stat when today's value changes
        try { updateWeeklyHoursStat(); } catch (_) {}
    }

    function updateWeeklyHoursStat() {
        const map = loadFromLocal(LS_KEYS.study) || {};
        // Sum the last 7 days including today
        const now = new Date();
        let totalSec = 0;
        for (let i = 0; i < 7; i++) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            const y = d.getFullYear();
            const m = (d.getMonth() + 1).toString().padStart(2, '0');
            const day = d.getDate().toString().padStart(2, '0');
            const key = `${y}-${m}-${day}`;
            totalSec += typeof map[key] === 'number' ? map[key] : 0;
        }
        const el = document.getElementById('stat-weekly-hours');
        if (!el) return;
        const hours = totalSec / 3600;
        el.textContent = `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
        el.title = `${Math.round(totalSec/60)} minutes (last 7 days)`;
        el.setAttribute('aria-label', `${Math.round(totalSec/60)} minutes in the last 7 days`);
    }

    // Auth modal and header controls
    const authModal = document.getElementById('auth-modal');
    const appContent = document.getElementById('app-content');
    // New unified auth modal elements
    const authForm = document.getElementById('auth-form');
    const tabButtonsEls = Array.from(document.querySelectorAll('#auth-modal .tab-btn'));
    const openLoginBtn = document.getElementById('open-login-btn');
    const signoutBtn = document.getElementById('signout-btn');
    const userInfo = document.getElementById('user-info');
    const guestInfo = document.getElementById('guest-info');
    const userEmailEl = document.getElementById('user-email');
    const authErrorEl = document.getElementById('auth-error');

    const views = {
        generator: document.getElementById('view-generator'),
        course: document.getElementById('view-course'),
        dashboard: document.getElementById('view-dashboard')
    };
    const resumeBtn = document.getElementById('resume-btn');
    
    const tabButtons = {
        notes: document.getElementById('tab-notes'),
        projects: document.getElementById('tab-projects')
    };
    const contentPanes = {
        notes: document.getElementById('content-notes'),
        projects: document.getElementById('content-projects')
    };
    const userStatusText = document.getElementById('user-status-text');
    // Pending link info when user tries to sign up with an email that exists via Google
    let pendingLink = null; // { email, password, provider: 'google.com' }
    function formatRelativeTime(ts) {
        if (!ts) return 'just now';
        const diff = Date.now() - ts;
        const sec = Math.floor(diff / 1000);
        if (sec < 60) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min} min${min>1?'s':''} ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr} hour${hr>1?'s':''} ago`;
        const day = Math.floor(hr / 24);
        if (day < 7) return `${day} day${day>1?'s':''} ago`;
        const date = new Date(ts);
        return date.toLocaleDateString();
    }


    // --- 3. AUTHENTICATION (Email/Password) ---
    function show(el) { if (el) el.classList.remove('hidden'); }
    function hide(el) { if (el) el.classList.add('hidden'); }
    function setError(msg) { if (authErrorEl) authErrorEl.textContent = msg || ''; }

    function mapAuthError(err, ctx) {
        const code = (err && (err.code || err.message || '')).toString();
        if (code.includes('auth/email-already-in-use')) {
            return 'This email is already registered. Try Login. If you used Google before, click “Continue with Google”.';
        }
        if (code.includes('auth/invalid-email')) return 'Please enter a valid email address.';
        if (code.includes('auth/weak-password')) return 'Use a stronger password (at least 6 characters).';
        if (code.includes('auth/wrong-password')) return 'Incorrect password. Try again or reset it.';
        if (code.includes('auth/user-not-found')) return 'No account found. Try Sign Up first.';
        if (code.includes('auth/popup-closed-by-user')) return 'Popup closed. Please try again.';
        return (err && err.message) ? err.message : (ctx === 'signup' ? 'Sign up failed' : 'Sign in failed');
    }
    function switchAuthView(view) {
        const submitBtn = document.getElementById('auth-submit');
        const submitLabel = submitBtn?.querySelector('.submit-label');
        const emailInput = document.getElementById('auth-email');
        const passwordInput = document.getElementById('auth-password');
        tabButtonsEls.forEach(btn => {
            const active = btn.dataset.tab === view;
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
            btn.classList.toggle('bg-slate-100', active);
            btn.classList.toggle('text-slate-800', active);
            btn.classList.toggle('bg-slate-50', !active);
            btn.classList.toggle('text-slate-600', !active);
        });
        authForm.dataset.mode = view;
        if (submitLabel) submitLabel.textContent = view === 'signup' ? 'Create Account' : 'Continue';
        if (passwordInput) passwordInput.value = '';
        setError('');
        // Auto-focus email field for quick entry
        setTimeout(() => emailInput && emailInput.focus(), 0);
    }

    async function handleSignUp(email, password) {
        setError('');
        try {
            await auth.createUserWithEmailAndPassword(email, password);
        } catch (e) {
            console.error('Sign up failed:', e);
            // If email exists, guide user based on sign-in methods
            if (e && e.code === 'auth/email-already-in-use' && auth?.fetchSignInMethodsForEmail) {
                try {
                    const methods = await auth.fetchSignInMethodsForEmail(email);
                    if (methods && methods.includes('password')) {
                        setError('Email already exists. Switch to Login and continue.');
                        switchAuthView('login');
                        const emailInput = document.getElementById('auth-email');
                        if (emailInput) emailInput.value = email;
                    } else if (methods && methods.includes('google.com')) {
                        setError('This email is registered with Google. Click “Continue with Google” to sign in. We can link your password after.');
                        pendingLink = { email, password, provider: 'google.com' };
                    } else {
                        setError(mapAuthError(e, 'signup'));
                    }
                } catch (mErr) {
                    console.warn('fetchSignInMethodsForEmail failed', mErr);
                    setError(mapAuthError(e, 'signup'));
                }
            } else {
                setError(mapAuthError(e, 'signup'));
            }
        }
    }

    async function handleSignIn(email, password) {
        setError('');
        try {
            await auth.signInWithEmailAndPassword(email, password);
        } catch (e) {
            console.error('Sign in failed:', e);
            setError(mapAuthError(e, 'login'));
        }
    }

    async function handleSignOut() {
        setError('');
        try {
            await auth.signOut();
        } catch (e) {
            console.error('Sign out failed:', e);
            setError(e && e.message ? e.message : 'Sign out failed');
        }
    }

    if (auth && typeof auth.onAuthStateChanged === 'function') {
        auth.onAuthStateChanged(user => {
            appState.user = user || null;
            const uid = appState.user ? appState.user.uid : null;
            if (user) {
                // UI for logged-in
                hide(authModal);
                show(appContent);
                if (userInfo) show(userInfo);
                if (guestInfo) hide(guestInfo);
                if (userEmailEl) userEmailEl.textContent = user.email || '';
                const wantDashboard = appState.forcedStartView === 'dashboard';
                switchView(wantDashboard ? 'dashboard' : 'dashboard');
                renderDashboard();
                // Load streak/timer and resume last course
                loadStreak();
                restoreTimerState();
                // Skip auto-resume when URL forces dashboard view
                if (appState.forcedStartView !== 'dashboard') {
                    const localCourse = loadFromLocal(LS_KEYS.lastCourse);
                    if (localCourse) loadCourse(localCourse);
                }
                // Clean URL once routed
                try {
                    const params = new URLSearchParams(location.search);
                    if (params.get('view')) {
                        params.delete('view');
                        const next = location.pathname + (params.toString() ? ('?' + params.toString()) : '') + location.hash;
                        window.history.replaceState(null, '', next);
                    }
                } catch (_) {}
            } else {
                // UI for logged-out
                hide(authModal); // keep modal closed by default on first load
                hide(appContent);
                if (userInfo) hide(userInfo);
                if (guestInfo) show(guestInfo);
                // Do not force modal; user can open Login/Sign Up from landing navbar
                // If URL requested dashboard, we'll route there after login
                switchView('generator');
            }
        });
    }

    // Attach tab switching
    tabButtonsEls.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            switchAuthView(btn.dataset.tab === 'signup' ? 'signup' : 'login');
        });
    });

    // Unified auth form submission
    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!auth) return;
            const mode = authForm.dataset.mode || 'login';
            const email = document.getElementById('auth-email')?.value?.trim();
            const password = document.getElementById('auth-password')?.value;
            if (!email || !password) {
                setError('Email and password required');
                return;
            }
            const submitBtn = document.getElementById('auth-submit');
            const spinner = submitBtn?.querySelector('.loading-spinner');
            const label = submitBtn?.querySelector('.submit-label');
            try {
                submitBtn && (submitBtn.disabled = true);
                spinner && spinner.classList.remove('hidden');
                label && label.classList.add('opacity-0');
                if (mode === 'signup') {
                    await handleSignUp(email, password);
                } else {
                    await handleSignIn(email, password);
                }
            } finally {
                submitBtn && (submitBtn.disabled = false);
                spinner && spinner.classList.add('hidden');
                label && label.classList.remove('opacity-0');
            }
        });
    }

    // Modal open/close wiring
    const closeAuthBtn = document.getElementById('close-auth-btn');
    if (openLoginBtn) openLoginBtn.addEventListener('click', () => { show(authModal); switchAuthView('login'); });
    if (closeAuthBtn) closeAuthBtn.addEventListener('click', () => hide(authModal));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(authModal); });

    // Password visibility toggle + basic strength meter
    const togglePwdBtn = document.getElementById('toggle-password-visibility');
    const pwdInput = document.getElementById('auth-password');
    const strengthEl = document.getElementById('password-strength');
    function evalStrength(p) {
        if (!p) return '';
        let score = 0;
        if (p.length >= 8) score++;
        if (/[A-Z]/.test(p)) score++;
        if (/[0-9]/.test(p)) score++;
        if (/[^A-Za-z0-9]/.test(p)) score++;
        return ['weak','fair','good','strong'][score-1] || 'weak';
    }
    if (pwdInput) {
        pwdInput.addEventListener('input', () => {
            const val = pwdInput.value;
            const s = evalStrength(val);
            if (strengthEl) strengthEl.textContent = val ? s : '';
        });
    }
    if (togglePwdBtn && pwdInput) {
        togglePwdBtn.addEventListener('click', () => {
            const isPw = pwdInput.type === 'password';
            pwdInput.type = isPw ? 'text' : 'password';
            togglePwdBtn.textContent = isPw ? 'Hide' : 'Show';
            pwdInput.focus();
        });
    }

    // Google sign-in
    const googleBtn = document.getElementById('google-signin-btn');
    if (googleBtn && auth && firebase?.auth?.GoogleAuthProvider) {
        googleBtn.addEventListener('click', async () => {
            setError('');
            try {
                const provider = new firebase.auth.GoogleAuthProvider();
                const result = await auth.signInWithPopup(provider);
                // If user attempted to sign up with password for a Google account, link it now
                if (pendingLink && result?.user && result.user.email === pendingLink.email) {
                    try {
                        const cred = firebase.auth.EmailAuthProvider.credential(pendingLink.email, pendingLink.password);
                        await result.user.linkWithCredential(cred);
                        pendingLink = null;
                        setError('Password linked to your Google account. You can use email/password next time.');
                    } catch (linkErr) {
                        console.warn('Link password failed:', linkErr);
                        setError(mapAuthError(linkErr, 'signup'));
                    }
                }
            } catch (err) {
                console.error('Google sign-in failed', err);
                setError(mapAuthError(err, 'login'));
            }
        });
    }

    // Forgot password handler with cooldown
    const forgotBtn = document.getElementById('auth-forgot');
    if (forgotBtn && auth) {
        const resetCooldown = { until: 0, timerId: null, baseText: forgotBtn.textContent || 'Forgot password?' };
        function startResetCooldown(seconds = 60) {
            if (resetCooldown.timerId) { clearInterval(resetCooldown.timerId); resetCooldown.timerId = null; }
            resetCooldown.until = Date.now() + seconds * 1000;
            forgotBtn.disabled = true;
            const tick = () => {
                const leftMs = resetCooldown.until - Date.now();
                if (leftMs <= 0) {
                    clearInterval(resetCooldown.timerId);
                    resetCooldown.timerId = null;
                    forgotBtn.disabled = false;
                    forgotBtn.textContent = resetCooldown.baseText;
                    return;
                }
                const left = Math.ceil(leftMs / 1000);
                forgotBtn.textContent = `Resend in ${left}s`;
            };
            tick();
            resetCooldown.timerId = setInterval(tick, 250);
        }

        forgotBtn.addEventListener('click', async () => {
            setError('');
            const now = Date.now();
            if (now < resetCooldown.until) {
                const left = Math.ceil((resetCooldown.until - now) / 1000);
                setError(`Please wait ${left}s before requesting another reset email.`);
                return;
            }
            const email = document.getElementById('auth-email')?.value?.trim();
            if (!email) {
                setError('Enter your email above, then click “Forgot password?” again.');
                const emailInput = document.getElementById('auth-email');
                emailInput && emailInput.focus();
                return;
            }
            try {
                await auth.sendPasswordResetEmail(email);
                setError('Password reset email sent. Check your inbox.');
                startResetCooldown(60);
            } catch (err) {
                console.error('Reset email failed', err);
                setError(mapAuthError(err, 'login'));
            }
        });
    }

    // Focus trap inside auth modal
    function trapFocus(e) {
        if (!authModal || authModal.classList.contains('hidden')) return;
        if (e.key !== 'Tab') return;
        const focusable = authModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const arr = Array.from(focusable).filter(el => !el.disabled && el.offsetParent !== null);
        if (!arr.length) return;
        const first = arr[0];
        const last = arr[arr.length -1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', trapFocus);


    // --- 4. CORE FUNCTIONS (REFACTORED FOR FIRESTORE) ---

    const switchView = (viewName) => {
        appState.currentView = viewName;
        Object.values(views).forEach(v => v.classList.add('hidden'));
        if (views[viewName]) {
            views[viewName].classList.remove('hidden');
        }
        userStatusText.classList.toggle('hidden', !appState.user || viewName === 'generator');
        updateResumeButton();
    };

    function updateAuthUI(user) {
        try {
            // Keep header text generic since sign-in UI is removed
            if (userStatusText) userStatusText.textContent = 'Welcome, Learner!';
        } catch (_) {}
    }

    // All auth modal helpers removed
    function updateResumeButton() {
        if (!resumeBtn) return;
        const localCourse = loadFromLocal(LS_KEYS.lastCourse);
        const canResume = !!(appState.currentCourse || localCourse);
        resumeBtn.classList.toggle('hidden', !canResume);
    }

    const loadCourse = (course) => {
        appState.currentCourse = course; 
        document.getElementById('course-title-sidebar').textContent = appState.currentCourse.title;
        renderSyllabus(appState.currentCourse);
        updateCourseProgress(appState.currentCourse);
        // Show customization meta if available
        try {
            const metaBarId = 'course-meta-bar';
            let metaBar = document.getElementById(metaBarId);
            if (!metaBar) {
                metaBar = document.createElement('div');
                metaBar.id = metaBarId;
                metaBar.className = 'text-xs mt-1 mb-2 px-2 py-1 rounded bg-gray-100 text-gray-600 flex gap-3 items-center';
                const headerEl = document.getElementById('course-title-sidebar').parentElement;
                headerEl && headerEl.appendChild(metaBar);
            }
            const d = (course.meta && course.meta.difficulty) ? course.meta.difficulty : (appState.customization && appState.customization.difficulty);
            const l = (course.meta && course.meta.length) ? course.meta.length : (appState.customization && appState.customization.length);
            if (d || l) {
                metaBar.innerHTML = `
                    ${d ? `<span class="inline-flex items-center gap-1"><strong>Level:</strong> ${String(d).charAt(0).toUpperCase() + String(d).slice(1)}</span>` : ''}
                    ${l ? `<span class="inline-flex items-center gap-1"><strong>Length:</strong> ${String(l).charAt(0).toUpperCase() + String(l).slice(1)}</span>` : ''}
                `;
                metaBar.classList.remove('hidden');
            } else {
                metaBar.classList.add('hidden');
            }
        } catch (_) { /* non-fatal */ }
        // Auto-open last active lesson if available, else first
        const ai = course?.activeLesson;
        const mIndex = (ai && Number.isInteger(ai.moduleIndex)) ? ai.moduleIndex : 0;
        const lIndex = (ai && Number.isInteger(ai.lessonIndex)) ? ai.lessonIndex : 0;
        loadLesson(appState.currentCourse, mIndex, lIndex);
        switchView('course');
        switchTab('notes');
        // Fallback persist
        saveToLocal(LS_KEYS.lastCourse, appState.currentCourse);
        updateResumeButton();
    };
    
    const renderDashboard = () => {
    const uid = appState.user && appState.user.uid;
    if (!uid) return;

        const grid = document.getElementById('dashboard-courses-grid');
        grid.innerHTML = '<p class="text-gray-500">Loading your courses...</p>';

    const coursesRef = db.collection('users').doc(uid).collection('courses');
        
        coursesRef.onSnapshot(querySnapshot => {
            const courses = [];
            querySnapshot.forEach(doc => {
                courses.push({ id: doc.id, ...doc.data() });
            });

            // Sort by updatedAt desc, fallback to createdAt desc
            courses.sort((a, b) => {
                const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
                const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
                return tb - ta;
            });

            grid.innerHTML = ''; 

            if (courses.length === 0) {
                grid.innerHTML = `<div class="md:col-span-3 text-center p-8 bg-gray-50 rounded-2xl"><h3 class="text-lg font-semibold">Welcome!</h3><p class="text-gray-500 mt-2">You haven't generated any courses yet. Go create one to get started!</p></div>`;
            } else {
                courses.forEach(course => {
                    const card = document.createElement('div');
                    card.className = 'course-card cursor-pointer';
                    card.dataset.courseId = course.id;
                    const allLessons = (course.modules || []).flatMap(m => m.lessons || []);
                    const completedLessons = allLessons.filter(l => l.completed).length;
                    const progress = allLessons.length > 0 ? Math.round((completedLessons / allLessons.length) * 100) : 0;
                    const ts = Date.parse(course.updatedAt || course.createdAt || 0) || 0;
                    const rel = formatRelativeTime(ts);
                    const al = course.activeLesson;
                    let continueText = '';
                    if (al && Number.isInteger(al.moduleIndex) && Number.isInteger(al.lessonIndex)) {
                        const m = course.modules?.[al.moduleIndex];
                        const l = m?.lessons?.[al.lessonIndex];
                        const label = l?.title || `Module ${al.moduleIndex + 1} • Lesson ${al.lessonIndex + 1}`;
                        continueText = label;
                    }
                    card.innerHTML = `
                        <div class="course-cover"></div>
                        <div class="course-card-body">
                            <div class="flex items-start gap-2">
                                <div class="course-meta flex-1">${allLessons.length} lessons</div>
                                <div class="text-[10px] text-slate-500 uppercase tracking-wider">${rel}</div>
                            </div>
                            <h3 class="font-semibold tracking-tight text-lg leading-snug">${course.title}</h3>
                            ${continueText ? `<p class="continue-text">Continue: ${continueText}</p>` : ''}
                            <div class="course-progress-track mt-2">
                                <div class="course-progress-bar" style="width:${progress}%;"></div>
                            </div>
                            <div class="flex items-center justify-between mt-2 text-[11px] text-slate-500">
                                <span>${progress}% Complete</span>
                                <button class="resume-course-btn btn btn-secondary btn-xs" style="padding:.4rem .65rem; font-size:.65rem;">Resume</button>
                            </div>
                        </div>`;
                    grid.appendChild(card);
                });
            }

            // Update simple stats: total courses and lessons completed
            try {
                const allLessons = courses.flatMap(c => (c.modules || []).flatMap(m => m.lessons || []));
                const completedLessons = allLessons.filter(l => l && l.completed).length;
                document.getElementById('stat-courses').textContent = String(courses.length);
                document.getElementById('stat-lessons').textContent = String(completedLessons);
            } catch (_) { /* non-fatal */ }
        }, error => {
            console.error("Error fetching courses: ", error);
            // Local resume fallback
            const localCourse = loadFromLocal(LS_KEYS.lastCourse);
            if (localCourse) {
                grid.innerHTML = '';
                const card = document.createElement('div');
                card.className = 'course-card cursor-pointer';
                card.dataset.courseId = localCourse.id || 'local';
                const allLessons = (localCourse.modules || []).flatMap(m => m.lessons || []);
                const completedLessons = allLessons.filter(l => l.completed).length;
                const progress = allLessons.length ? Math.round((completedLessons / allLessons.length) * 100) : 0;
                card.innerHTML = `
                    <div class="course-cover"></div>
                    <div class="course-card-body">
                        <div class="course-meta">${allLessons.length} lessons</div>
                        <h3 class="font-semibold tracking-tight text-lg leading-snug mt-1">${localCourse.title || 'Resume Last Course'}</h3>
                        <div class="course-progress-track mt-3">
                            <div class="course-progress-bar" style="width:${progress}%"></div>
                        </div>
                        <div class="flex items-center justify-between mt-2 text-[11px] text-slate-500">
                            <span>${progress}% Complete</span>
                            <button class="resume-course-btn btn btn-secondary" style="padding:.4rem .65rem; font-size:.65rem;">Open</button>
                        </div>
                    </div>`;
                card.addEventListener('click', () => loadCourse(localCourse));
                grid.appendChild(card);
                // Update stats from local snapshot
                try {
                    document.getElementById('stat-courses').textContent = '1';
                    document.getElementById('stat-lessons').textContent = String(completedLessons);
                } catch (_) {}
            } else {
                grid.innerHTML = `<p class="text-red-500 md:col-span-3 text-center">Could not load courses. Please check your connection and Firestore security rules.</p>`;
            }
        });
        
        // Stats will be updated by the snapshot listener above
    };


    // --- 5. EVENT LISTENERS (REFACTORED FOR FIRESTORE) ---

    document.getElementById('generate-course-btn').addEventListener('click', async () => {
        const topicInput = document.getElementById('topic-input');
        const topic = topicInput.value.trim();
        if (topic === '') {
             topicInput.focus();
            return;
        }

        const loadingIndicator = document.getElementById('loading-indicator');
        loadingIndicator.classList.remove('hidden');

        try {
            const customization = appState.customization || loadFromLocal('intelli:customization') || null;
            let response = await fetch(`${API_BASE}/generate-course`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Send topic and userId when available
                body: JSON.stringify({ topic: topic, userId: (appState.user && appState.user.uid) || null, options: customization }),
            });

            // Fallback: some versions/routes used /api/generate-course
            if (!response.ok) {
                console.warn('Primary endpoint failed', response.status);
                response = await fetch(`${API_BASE}/api/generate-course`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ topic: topic, userId: (appState.user && appState.user.uid) || null, options: customization }),
                });
            }

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const courseData = await response.json();
            console.log("Received course from server with ID:", courseData.id, 'saved:', courseData.saved);

            // Client-side fallback save if server couldn't save (e.g., no admin key) and we have userId
            if (!courseData.saved && appState.user && db) {
                try {
                    await db.collection('users').doc(appState.user.uid).collection('courses').doc(String(courseData.id)).set({
                        ...courseData,
                        ownerId: appState.user.uid,
                        createdAt: courseData.createdAt || new Date().toISOString(),
                    }, { merge: true });
                    console.log('Saved course to Firestore (client-side).');
                } catch (e) {
                    console.warn('Client Firestore save failed:', e);
                }
            }

            loadCourse(courseData);
            // Always save to local as a fallback snapshot
            saveToLocal(LS_KEYS.lastCourse, courseData);

        } catch (error) {
            console.error("Could not generate course:", error);
            console.error('Hint: ensure the backend is running (npm start) and open http://localhost:3000, not the file path.');
            alert("Failed to generate course. Please check that your backend and AI services are running correctly.");
        } finally {
            loadingIndicator.classList.add('hidden');
        }
    });

    document.getElementById('dashboard-courses-grid').addEventListener('click', async (e) => {
        // Handle per-card Resume button
        const resumeEl = e.target.closest('.resume-course-btn');
        if (resumeEl) {
            e.preventDefault();
            e.stopPropagation();
            const card = resumeEl.closest('[data-course-id]');
            if (card && appState.user) {
                const courseId = card.dataset.courseId;
                const courseDoc = await db.collection('users').doc(appState.user.uid).collection('courses').doc(courseId).get();
                if (courseDoc.exists) {
                    loadCourse({ id: courseDoc.id, ...courseDoc.data() });
                    saveToLocal(LS_KEYS.lastCourse, { id: courseDoc.id, ...courseDoc.data() });
                }
            }
            return;
        }
        const card = e.target.closest('[data-course-id]');
        if(card && appState.user) {
            const courseId = card.dataset.courseId;
            const courseDoc = await db.collection('users').doc(appState.user.uid).collection('courses').doc(courseId).get();
            if (courseDoc.exists) {
                loadCourse({ id: courseDoc.id, ...courseDoc.data() });
                saveToLocal(LS_KEYS.lastCourse, { id: courseDoc.id, ...courseDoc.data() });
            } else {
                console.error("Could not find the clicked course in the database.");
            }
        }
    });

    document.getElementById('mark-complete-btn').addEventListener('click', async (e) => {
        if (!appState.currentCourse || !appState.currentCourse.activeLesson) return;

        const { moduleIndex, lessonIndex } = appState.currentCourse.activeLesson;
        // Optimistic UI update
        const lesson = appState.currentCourse.modules?.[moduleIndex]?.lessons?.[lessonIndex];
    if (!lesson) return;
    const nextState = !lesson.completed;
    lesson.completed = nextState;
    renderSyllabus(appState.currentCourse);
    updateCourseProgress(appState.currentCourse);
    // Save snapshot to local
    saveToLocal(LS_KEYS.lastCourse, appState.currentCourse);
    e.currentTarget.querySelector('span').textContent = nextState ? 'Completed' : 'Mark as Complete';
    e.currentTarget.disabled = false;

        // Try server update first (preferred)
        try {
            if (appState.user) {
                const resp = await fetch(`${API_BASE}/courses/${encodeURIComponent(appState.currentCourse.id)}/complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: appState.user.uid,
                        moduleIndex,
                        lessonIndex,
                        completed: nextState,
                    }),
                });
                if (resp.ok) {
                    const j = await resp.json();
                    if (j?.course) {
                        appState.currentCourse = j.course;
                        saveToLocal(LS_KEYS.lastCourse, appState.currentCourse);
                    }
                    return;
                }
            }
            // Client-side fallback if server not available
            if (db && appState.user) {
                const ref = db.collection('users').doc(appState.user.uid).collection('courses').doc(String(appState.currentCourse.id));
                const updatedAt = new Date().toISOString();
                appState.currentCourse.updatedAt = updatedAt;
                await ref.set({ ...appState.currentCourse, updatedAt }, { merge: true });
            }
        } catch (err) {
            console.warn('Lesson complete persist failed:', err);
        }
    });

    // --- Event Listeners ---
    document.getElementById('home-logo').addEventListener('click', () => switchView('generator'));
    document.getElementById('dashboard-btn').addEventListener('click', () => { switchView('dashboard'); });
    // (Legacy standalone auth forms removed; unified auth modal handles submission & tab switching earlier.)
    if (signoutBtn) signoutBtn.addEventListener('click', () => handleSignOut());
    // Auth form event listeners removed
    if (resumeBtn) {
        resumeBtn.addEventListener('click', () => {
            const localCourse = loadFromLocal(LS_KEYS.lastCourse);
            const course = appState.currentCourse || localCourse;
            if (course) loadCourse(course);
        });
    }
    document.getElementById('create-new-course-btn').addEventListener('click', () => switchView('generator'));
    tabButtons.notes.addEventListener('click', () => switchTab('notes'));
    tabButtons.projects.addEventListener('click', () => switchTab('projects'));
    // Customize Course Modal logic (simplified with direct id)
    const customizeCourseBtn = document.getElementById('customize-course-btn');
    const customizeModal = document.getElementById('customize-modal');
    const customizeOverlay = document.getElementById('customize-overlay');
    const customizeClose = document.getElementById('customize-close');
    const customizeCancel = document.getElementById('customize-cancel');
    const customizeForm = document.getElementById('customize-form');
    // Premium modal elements
    const premiumBtn = document.querySelector('.btn.btn-premium');
    const premiumModal = document.getElementById('premium-modal');
    const premiumOverlay = document.getElementById('premium-overlay');
    const premiumClose = document.getElementById('premium-close');
    const premiumList = document.getElementById('premium-list');
    const premiumLoading = document.getElementById('premium-loading');
    const premiumError = document.getElementById('premium-error');
    const premiumRegenerate = document.getElementById('premium-regenerate');

    function openPremium() { if(!premiumModal||!premiumOverlay) return; premiumOverlay.classList.remove('hidden'); premiumModal.classList.remove('hidden'); }
    function closePremium() { premiumOverlay?.classList.add('hidden'); premiumModal?.classList.add('hidden'); }
    premiumClose && premiumClose.addEventListener('click', closePremium);
    premiumOverlay && premiumOverlay.addEventListener('click', closePremium);
    document.addEventListener('keydown', e=>{ if(e.key==='Escape') closePremium(); });

    function premiumFallback(topic){
        return [
            { title:`${topic} Elite Bootcamp`, format:'cohort', difficulty:'advanced', value:'Mentor-led deep dive with capstone', estHours:'40+', url:'#' },
            { title:`${topic} Systems Mastery`, format:'video series', difficulty:'advanced', value:'Architecture & scaling playbook', estHours:'10', url:'#' },
            { title:`${topic} Interactive Labs`, format:'interactive', difficulty:'mixed', value:'Hands-on guided challenge sets', estHours:'15', url:'#' },
            { title:`${topic} Performance Tuning`, format:'video series', difficulty:'advanced', value:'Profiling, optimization patterns', estHours:'8', url:'#' },
            { title:`Production ${topic} Projects`, format:'interactive', difficulty:'intermediate', value:'Portfolio-grade build sprints', estHours:'18', url:'#' },
            { title:`${topic} Interview Accelerator`, format:'cohort', difficulty:'advanced', value:'Scenario & mock interview loops', estHours:'25+', url:'#' }
        ];
    }
    function renderPremium(items){
        premiumList.innerHTML = items.map(it=>`<li><div class=\"flex items-start gap-2\"><span class=\"premium-badge\">${(it.difficulty||'premium').slice(0,12)}</span><div class=\"premium-meta flex-1 justify-end text-right\">${it.format||''}</div></div><p class=\"premium-title\">${it.title}</p><div class=\"premium-value\">${it.value||''}</div><div class=\"premium-hours\">~${it.estHours||''}</div><a class=\"premium-link\" href=\"${it.url||'#'}\" target=\"_blank\" rel=\"noopener\">View</a></li>`).join('');
    }
    async function fetchPremium(topic){
        premiumError.classList.add('hidden');
        premiumList.classList.add('hidden');
        premiumLoading.classList.remove('hidden');
        premiumList.innerHTML='';
        const endpoint = `${API_BASE}/api/premium-courses`;
        try {
            const r = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic})});
            if(!r.ok) throw new Error('bad status '+r.status);
            const j = await r.json();
            let items = Array.isArray(j.suggestions)? j.suggestions : [];
            if(!items.length) items = premiumFallback(topic);
            renderPremium(items);
            premiumLoading.classList.add('hidden');
            premiumList.classList.remove('hidden');
        } catch(err){
            renderPremium(premiumFallback(topic));
            premiumLoading.classList.add('hidden');
            premiumList.classList.remove('hidden');
            premiumError.textContent = 'Live suggestions unavailable. Showing fallback list.';
            premiumError.classList.remove('hidden');
        }
    }

    function resolveCurrentTopic(){
        // Prefer current course title, else textbox
        if(appState.currentCourse?.title) return appState.currentCourse.title.replace(/Course$/i,'').trim();
        const raw = document.getElementById('topic-input')?.value?.trim();
        return raw || 'Learning';
    }

    premiumBtn && premiumBtn.addEventListener('click', () => {
        openPremium();
        const topic = resolveCurrentTopic();
        fetchPremium(topic);
    });
    premiumRegenerate && premiumRegenerate.addEventListener('click', ()=>{
        const topic = resolveCurrentTopic();
        fetchPremium(topic);
    });

    // --- Quiz Feature ---
    const quizOpenBtn = document.getElementById('quiz-open-btn');
    const quizOverlay = document.getElementById('quiz-overlay');
    const quizModal = document.getElementById('quiz-modal');
    const quizClose = document.getElementById('quiz-close');
    const quizQuestionsEl = document.getElementById('quiz-questions');
    const quizLoading = document.getElementById('quiz-loading');
    const quizError = document.getElementById('quiz-error');
    const quizResults = document.getElementById('quiz-results');
    const quizSubmit = document.getElementById('quiz-submit');
    const quizRegenerate = document.getElementById('quiz-regenerate');

    let quizState = { answers: {}, correct: [], source: null };

    function openQuiz(){
        if(!quizOverlay||!quizModal) return; 
        quizOverlay.classList.remove('hidden');
        quizModal.classList.remove('hidden');
        startQuizGeneration();
    }
    function closeQuiz(){
        quizOverlay?.classList.add('hidden');
        quizModal?.classList.add('hidden');
    }
    quizClose && quizClose.addEventListener('click', closeQuiz);
    quizOverlay && quizOverlay.addEventListener('click', e=>{ if(e.target===quizOverlay) closeQuiz(); });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeQuiz(); });

    function getLessonContentForQuiz(){
        // Use current notes HTML stripped to text as lessonContent; fallback to course title
        const notesHtml = document.getElementById('content-notes')?.innerText || '';
        if (notesHtml.trim().length > 40) return notesHtml.trim().slice(0, 6000);
        return (appState.currentCourse?.title || 'Learning topic fundamentals');
    }

    async function startQuizGeneration(){
        quizError.classList.add('hidden');
        quizResults.classList.add('hidden');
        quizSubmit.classList.add('hidden');
        quizRegenerate.classList.add('hidden');
        quizQuestionsEl.classList.add('hidden');
        quizQuestionsEl.innerHTML='';
        quizLoading.classList.remove('hidden');
        const lessonContent = getLessonContentForQuiz();
        try {
            const r = await fetch(`${API_BASE}/api/generate-quiz`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lessonContent })});
            if(!r.ok) throw new Error('Request failed');
            const j = await r.json();
            renderQuiz(j.quiz || [], j.source, j.reason);
        } catch(err){
            quizLoading.classList.add('hidden');
            quizError.textContent = 'Unable to generate quiz (using fallback).';
            quizError.classList.remove('hidden');
        }
    }

    function renderQuiz(quiz, source, reason){
        quizState = { answers:{}, correct: quiz.map(q=>q.correctAnswer), source, reason };
        quizLoading.classList.add('hidden');
        if(!Array.isArray(quiz) || !quiz.length){
            quizError.textContent = 'No quiz content available.';
            quizError.classList.remove('hidden');
            return;
        }
        quizQuestionsEl.innerHTML = quiz.map((q,i)=>{
            const letters = ['A','B','C','D'];
            return `<li class="quiz-question" data-index="${i}">
                <h4>${q.question}</h4>
                <ul class="quiz-options">${q.options.map((opt,oi)=>`<li class="quiz-option" data-opt="${encodeURIComponent(opt)}"><span class="quiz-letter">${letters[oi]}</span><span class="quiz-text flex-1">${opt}</span></li>`).join('')}</ul>
            </li>`;
        }).join('');
        quizQuestionsEl.classList.remove('hidden');
        quizSubmit.classList.remove('hidden');
        quizRegenerate.classList.remove('hidden');
    }

    function handleQuizClick(e){
        const opt = e.target.closest('.quiz-option');
        if(!opt) return;
        const qEl = opt.closest('.quiz-question');
        const idx = Number(qEl.dataset.index);
        // clear previous selection
        qEl.querySelectorAll('.quiz-option').forEach(o=>o.classList.remove('selected'));
        opt.classList.add('selected');
        quizState.answers[idx] = decodeURIComponent(opt.dataset.opt);
    }
    quizQuestionsEl && quizQuestionsEl.addEventListener('click', handleQuizClick);

    function gradeQuiz(){
        const total = quizState.correct.length;
        let score = 0;
        quizQuestionsEl.querySelectorAll('.quiz-question').forEach((qEl,i)=>{
            const chosen = quizState.answers[i];
            const correct = quizState.correct[i];
            qEl.querySelectorAll('.quiz-option').forEach(li=>{
                const val = decodeURIComponent(li.dataset.opt);
                if(val===correct) li.classList.add('correct');
                if(val===chosen && val!==correct) li.classList.add('incorrect');
                li.classList.add('disabled');
            });
            if(chosen===correct) score++;
        });
        quizSubmit.classList.add('hidden');
        quizResults.textContent = `Score: ${score}/${total} (${Math.round((score/total)*100)}%)` + (quizState.source==='fallback' ? ' • (Fallback quiz)' : '');
        quizResults.classList.remove('hidden');
    }
    quizSubmit && quizSubmit.addEventListener('click', gradeQuiz);
    quizRegenerate && quizRegenerate.addEventListener('click', startQuizGeneration);
    quizOpenBtn && quizOpenBtn.addEventListener('click', openQuiz);

    function openCustomize() {
        if (!customizeModal || !customizeOverlay) return;
        customizeOverlay.classList.remove('hidden');
        customizeModal.classList.remove('hidden');
        // Focus first radio for accessibility
        const firstRadio = customizeForm?.querySelector('input[name="difficulty"]');
        firstRadio && firstRadio.focus();
    }
    function closeCustomize() {
        customizeOverlay?.classList.add('hidden');
        customizeModal?.classList.add('hidden');
    }
    if (customizeCourseBtn) customizeCourseBtn.addEventListener('click', openCustomize);
    customizeClose?.addEventListener('click', closeCustomize);
    customizeCancel?.addEventListener('click', closeCustomize);
    customizeOverlay?.addEventListener('click', (e) => { if (e.target === customizeOverlay) closeCustomize(); });
    customizeForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(customizeForm);
        const difficulty = fd.get('difficulty');
        const length = fd.get('length');
        console.log('Customize selections:', { difficulty, length });
        appState.customization = { difficulty, length, ts: Date.now() };
        // Persist locally so next session retains last choice
        saveToLocal('intelli:customization', appState.customization);
        closeCustomize();
        // Placeholder: hook into generation logic later if needed
    });
    document.getElementById('syllabus-container').addEventListener('click', (e) => {
        const lessonItem = e.target.closest('.lesson-item');
        if (!lessonItem || !appState.currentCourse) return;
        const moduleIndex = parseInt(lessonItem.dataset.moduleIndex);
        const lessonIndex = parseInt(lessonItem.dataset.lessonIndex);
        loadLesson(appState.currentCourse, moduleIndex, lessonIndex);
    });

    // --- UI Helpers ---
    function switchTab(tabName) {
        Object.values(tabButtons).forEach(b => {
            b.classList.remove('text-[#5A7D6C]', 'border-[#6B8A7A]');
            b.classList.add('text-gray-500', 'border-transparent');
        });
        Object.values(contentPanes).forEach(p => p.classList.add('hidden'));
        if (tabButtons[tabName]) {
            tabButtons[tabName].classList.add('text-[#5A7D6C]', 'border-[#6B8A7A]');
            tabButtons[tabName].classList.remove('text-gray-500', 'border-transparent');
        }
        if (contentPanes[tabName]) contentPanes[tabName].classList.remove('hidden');
    }

    function renderSyllabus(course) {
        const container = document.getElementById('syllabus-container');
        container.innerHTML = '';
        (course.modules || []).forEach((module, moduleIndex) => {
            const moduleEl = document.createElement('div');
            const lessonsHtml = (module.lessons || []).map((lesson, lessonIndex) => {
                const isPaidAndLocked = lesson.type === 'paid' && false; // placeholder for future gating
                const icon = isPaidAndLocked
                    ? '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-slate-500" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clip-rule="evenodd" /></svg>'
                    : '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg>';
                return `
                    <li data-module-index="${moduleIndex}" data-lesson-index="${lessonIndex}" class="lesson-item ${isPaidAndLocked ? 'paid-lesson' : ''}">
                        ${icon}
                        <span class="flex-grow font-medium tracking-tight">${lesson.title}</span>
                    </li>`;
            }).join('');
            moduleEl.innerHTML = `
                <h3 class="font-bold text-md mb-2 px-2">${module.title}</h3>
                <ul class="space-y-1">${lessonsHtml}</ul>
            `;
            container.appendChild(moduleEl);
        });
    }

    function updateCourseProgress(course) {
        const allLessons = (course.modules || []).flatMap(m => m.lessons || []);
        const completedLessons = allLessons.filter(l => l.completed).length;
        const totalLessons = allLessons.length || 0;
        const progress = totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0;
        document.getElementById('course-progress-bar').style.width = `${progress}%`;
        document.getElementById('course-progress-text').textContent = `${Math.round(progress)}% Complete (${completedLessons}/${totalLessons} lessons)`;
    }

    function loadLesson(course, moduleIndex, lessonIndex) {
        const lesson = (course.modules?.[moduleIndex]?.lessons?.[lessonIndex]) || null;
        if (!lesson) return;
        const contentNotes = document.getElementById('content-notes');
        const markCompleteBtn = document.getElementById('mark-complete-btn');
        const videoContainer = document.getElementById('video-container');
        document.getElementById('lesson-title').textContent = lesson.title || '';
        // Client-side safety net: assign a fallback video if missing/invalid
        try {
            const isValidId = (id) => typeof id === 'string' && /^[\w-]{11}$/.test(id);
            if (!isValidId(lesson.videoId)) {
                const defaults = ['kqtD5dpn9C8', 'PkZNo7MFNFg', 'sBws8MSXN7A'];
                const pick = defaults[(moduleIndex * 7 + lessonIndex) % defaults.length];
                lesson.videoId = pick;
                // Persist to local snapshot so refresh keeps the fallback
                try { saveToLocal(LS_KEYS.lastCourse, course); } catch (_) {}
            }
        } catch (_) {}
        if (lesson.videoId && lesson.videoId !== 'null') {
            videoContainer.innerHTML = `<iframe id="video-player" class="w-full h-full" src="https://www.youtube.com/embed/${lesson.videoId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
        } else {
            videoContainer.innerHTML = `
                <div class="w-full h-full flex items-center justify-center bg-gray-50 text-gray-600">
                    <div class="text-center p-6">
                        <div class="text-4xl mb-2">🎬</div>
                        <p>No video found for this lesson. You can still read the notes below.</p>
                    </div>
                </div>`;
        }
        contentNotes.innerHTML = lesson.notes || '';
    markCompleteBtn.style.display = 'inline-flex';
    markCompleteBtn.querySelector('span').textContent = lesson.completed ? 'Completed' : 'Mark as Complete';
    // Keep enabled to allow toggling on/off
    markCompleteBtn.disabled = false;
        course.activeLesson = { moduleIndex, lessonIndex };
        // Persist last active lesson to Firestore (best-effort)
        if (db && appState.user && course.id) {
            try {
                const ref = db.collection('users').doc(appState.user.uid).collection('courses').doc(String(course.id));
                const updatedAt = new Date().toISOString();
                course.updatedAt = updatedAt;
                ref.set({ activeLesson: { moduleIndex, lessonIndex }, updatedAt }, { merge: true });
            } catch (e) {
                console.warn('Failed to save activeLesson:', e);
            }
        }
        // Also persist to local snapshot
        saveToLocal(LS_KEYS.lastCourse, course);
        document.querySelectorAll('.lesson-item').forEach(el => el.classList.remove('active-lesson'));
        const activeLessonEl = document.querySelector(`.lesson-item[data-module-index="${moduleIndex}"][data-lesson-index="${lessonIndex}"]`);
        if (activeLessonEl) activeLessonEl.classList.add('active-lesson');
        document.getElementById('content-projects').innerHTML = course.projectIdeas || '';
        // Track learning activity for streaks
        try { bumpStreak(); } catch (_) {}
    }

    // --- Productivity Tools ---
    // Focus Timer (Pomodoro-like)
    const WORK_DURATION = 25 * 60; // seconds
    const BREAK_DURATION = 5 * 60;
    appState.timer.mode = appState.timer.mode || 'work';
    const timerDisplayEl = document.getElementById('timer-display');
    const startBtn = document.getElementById('timer-start');
    const pauseBtn = document.getElementById('timer-pause');
    const resetBtn = document.getElementById('timer-reset');
    const timerSettingsBtn = document.getElementById('timer-settings-btn');
    const timerCustomization = document.getElementById('timer-customization');
    const customTimeInput = document.getElementById('custom-time-input');
    const setTimeBtn = document.getElementById('set-time-btn');

    // Attach timer-related event listeners now that all elements & helper vars exist
    (function initTimerUI(){
        const editVideoBtn = document.getElementById('edit-video-btn');
        if (editVideoBtn) editVideoBtn.addEventListener('click', () => {});
        if (startBtn) startBtn.addEventListener('click', startTimer);
        if (pauseBtn) pauseBtn.addEventListener('click', pauseTimer);
        if (resetBtn) resetBtn.addEventListener('click', resetTimer);
        if (timerSettingsBtn) timerSettingsBtn.addEventListener('click', () => {
            if (!timerCustomization) return;
            if (customTimeInput) {
                const mins = Math.max(1, Math.round((appState.timer.defaultTime || 1500) / 60));
                customTimeInput.value = String(mins);
            }
            timerCustomization.classList.toggle('hidden');
        });
        if (setTimeBtn) setTimeBtn.addEventListener('click', () => {
            if (!customTimeInput) return;
            const minutes = parseInt(customTimeInput.value, 10);
            if (Number.isNaN(minutes) || minutes <= 0) {
                alert('Please enter a valid positive number of minutes.');
                return;
            }
            const secs = minutes * 60;
            appState.timer.defaultTime = secs;
            appState.timer.mode = 'work';
            appState.timer.isRunning = false;
            appState.timer.timeLeft = secs;
            if (appState.timer.intervalId) {
                clearInterval(appState.timer.intervalId);
                appState.timer.intervalId = null;
            }
            updateTimerDisplay();
            saveTimerState();
            if (timerCustomization) timerCustomization.classList.add('hidden');
        });
    })();

    function formatTime(sec) {
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    function saveTimerState() {
        saveToLocal(LS_KEYS.timer, {
            mode: appState.timer.mode,
            timeLeft: appState.timer.timeLeft,
            isRunning: appState.timer.isRunning,
            defaultTime: appState.timer.defaultTime,
            ts: Date.now(),
        });
    }

    function restoreTimerState() {
        const saved = loadFromLocal(LS_KEYS.timer);
        if (!saved) {
            appState.timer.mode = 'work';
            appState.timer.defaultTime = 25 * 60;
            appState.timer.timeLeft = appState.timer.defaultTime;
            appState.timer.isRunning = false;
            updateTimerDisplay();
            return;
        }
        // Basic restore without drift correction for simplicity
        appState.timer.mode = saved.mode || 'work';
        appState.timer.defaultTime = typeof saved.defaultTime === 'number' ? saved.defaultTime : 25 * 60;
        appState.timer.timeLeft = typeof saved.timeLeft === 'number' ? saved.timeLeft : (saved.mode === 'break' ? BREAK_DURATION : appState.timer.defaultTime);
        appState.timer.isRunning = false; // always start paused on restore for safety
        updateTimerDisplay();
    }

    function updateTimerDisplay() {
        const sec = Math.max(0, appState.timer.timeLeft);
        if (timerDisplayEl) timerDisplayEl.textContent = formatTime(sec);
        // Update button states
        if (startBtn) startBtn.disabled = appState.timer.isRunning;
        if (pauseBtn) pauseBtn.disabled = !appState.timer.isRunning;
        if (resetBtn) resetBtn.disabled = false;
    }

    function tick() {
        if (!appState.timer.isRunning) return;
        appState.timer.timeLeft -= 1;
        if (appState.timer.mode === 'work') {
            try { addStudySeconds(1); } catch (_) {}
        }
        if (appState.timer.timeLeft <= 0) {
            // Auto-switch modes
            appState.timer.mode = appState.timer.mode === 'work' ? 'break' : 'work';
            // When entering work mode, honor the user-customized defaultTime
            appState.timer.timeLeft = appState.timer.mode === 'work' ? (appState.timer.defaultTime || WORK_DURATION) : BREAK_DURATION;
            // Simple feedback
            try { window.navigator.vibrate && window.navigator.vibrate(200); } catch (_) {}
        }
        updateTimerDisplay();
        saveTimerState();
    }

    function startTimer() {
        if (appState.timer.isRunning) return;
        appState.timer.isRunning = true;
        // Always clear any previous interval to avoid multiple timers
        if (appState.timer.intervalId) {
            clearInterval(appState.timer.intervalId);
            appState.timer.intervalId = null;
        }
        appState.timer.intervalId = setInterval(tick, 1000);
        updateTimerDisplay();
        saveTimerState();
    }

    function pauseTimer() {
        appState.timer.isRunning = false;
        if (appState.timer.intervalId) {
            clearInterval(appState.timer.intervalId);
            appState.timer.intervalId = null;
        }
        updateTimerDisplay();
        saveTimerState();
    }

    function resetTimer() {
        appState.timer.isRunning = false;
        if (appState.timer.intervalId) {
            clearInterval(appState.timer.intervalId);
            appState.timer.intervalId = null;
        }
        if (appState.timer.mode === 'work') {
            appState.timer.timeLeft = appState.timer.defaultTime;
        } else {
            appState.timer.timeLeft = BREAK_DURATION;
        }
        updateTimerDisplay();
        saveTimerState();
    }

    // Initialize "Hours Today" from stored study seconds on load
    try {
        const s = (function(){
            const data = loadFromLocal(LS_KEYS.study) || {};
            const key = (function(){ const d = new Date(); const y=d.getFullYear(); const m=(d.getMonth()+1).toString().padStart(2,'0'); const day=d.getDate().toString().padStart(2,'0'); return `${y}-${m}-${day}`; })();
            return { sec: typeof data[key] === 'number' ? data[key] : 0 };
        })();
        updateStudyHoursUI(s.sec);
        updateWeeklyHoursStat();
    } catch(_){}

    // Day Streak
    function todayKey() {
        const d = new Date();
        const y = d.getFullYear();
        const m = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    async function loadStreak() {
        try {
            // Prefer Firestore
            if (db && appState.user) {
                const ref = db.collection('users').doc(appState.user.uid).collection('meta').doc('streak');
                const snap = await ref.get();
                if (snap.exists) {
                    const data = snap.data() || {};
                    const count = data.count || 0;
                    const stat = document.getElementById('stat-streak');
                    if (stat) stat.textContent = `${count} 🔥`;
                    const countEl = document.getElementById('streak-count');
                    if (countEl) countEl.textContent = String(count);
                    const disp = document.getElementById('streak-display');
                    if (disp) disp.classList.toggle('glowing', count > 0);
                    saveToLocal(LS_KEYS.streak, data);
                    return;
                }
            }
        } catch (_) {}
        // Fallback to local
        const local = loadFromLocal(LS_KEYS.streak) || { count: 0, last: null };
        const count = local.count || 0;
        const stat = document.getElementById('stat-streak');
        if (stat) stat.textContent = `${count} 🔥`;
        const countEl = document.getElementById('streak-count');
        if (countEl) countEl.textContent = String(count);
        const disp = document.getElementById('streak-display');
        if (disp) disp.classList.toggle('glowing', count > 0);
    }

    async function bumpStreak() {
        const t = todayKey();
        let current = loadFromLocal(LS_KEYS.streak) || { count: 0, last: null };
        if (current.last === t) {
            // already counted today
        } else {
            if (current.last) {
                const prev = new Date(current.last);
                const now = new Date(t);
                const diffDays = Math.round((now - prev) / (1000 * 60 * 60 * 24));
                const prevCount = current.count;
                current.count = diffDays === 1 ? (current.count + 1) : 1;
                if (current.count > prevCount) {
                    // Celebrate bump
                    showToast({ title: `Streak ${current.count}!`, text: 'New day, keep it going.', icon: '🔥' });
                }
            } else {
                const prevCount = current.count;
                current.count = 1;
                if (current.count > prevCount) {
                    showToast({ title: `Streak ${current.count}!`, text: 'First day—nice start.', icon: '🔥' });
                }
            }
            current.last = t;
            saveToLocal(LS_KEYS.streak, current);
            const stat = document.getElementById('stat-streak');
            if (stat) stat.textContent = `${current.count} 🔥`;
            const countEl = document.getElementById('streak-count');
            if (countEl) countEl.textContent = String(current.count);
            const disp = document.getElementById('streak-display');
            if (disp) disp.classList.toggle('glowing', current.count > 0);
            // Persist to Firestore best-effort
            try {
                if (db && appState.user) {
                    const ref = db.collection('users').doc(appState.user.uid).collection('meta').doc('streak');
                    await ref.set({ count: current.count, last: current.last }, { merge: true });
                }
            } catch (_) {}
        }
    }

    // Increment/reset streak based on calendar-day visit (no lesson required)
    async function updateStreakOnVisit() {
        try {
            const t = todayKey();
            let current = loadFromLocal(LS_KEYS.streak) || { count: 0, last: null };
            if (current.last === t) {
                // already recorded today; just ensure UI reflects stored value
            } else {
                if (current.last) {
                    const prev = new Date(current.last);
                    const now = new Date(t);
                    const diffDays = Math.round((now - prev) / (1000 * 60 * 60 * 24));
                    const prevCount = current.count;
                    current.count = (diffDays === 1) ? (current.count + 1) : 1;
                    if (current.count > prevCount) {
                        showToast({ title: `Streak ${current.count}!`, text: 'Daily streak rolled over.', icon: '🔥' });
                    }
                } else {
                    const prevCount = current.count;
                    current.count = 1;
                    if (current.count > prevCount) {
                        showToast({ title: `Streak ${current.count}!`, text: 'First day—nice start.', icon: '🔥' });
                    }
                }
                current.last = t;
                saveToLocal(LS_KEYS.streak, current);
                // best-effort sync
                try {
                    if (db && appState.user) {
                        const ref = db.collection('users').doc(appState.user.uid).collection('meta').doc('streak');
                        await ref.set({ count: current.count, last: current.last }, { merge: true });
                    }
                } catch (_) {}
            }
            // Update UI either way
            const stat = document.getElementById('stat-streak');
            if (stat) stat.textContent = `${current.count || 0} 🔥`;
            const countEl = document.getElementById('streak-count');
            if (countEl) countEl.textContent = String(current.count || 0);
            const disp = document.getElementById('streak-display');
            if (disp) disp.classList.toggle('glowing', (current.count || 0) > 0);
        } catch (_) { /* non-fatal */ }
    }

    // Initialize and roll streak on visit so it doesn't stick at 1
    try { updateStreakOnVisit(); } catch (_) {}
    try { loadStreak(); } catch (_) {}
    function renderActivityChart() { /* noop */ }
    // Auth diagnostics removed

    // --- Notes Feature (toggle, load, save) ---
    (function initNotesFeature(){
        const notesContainer = document.getElementById('notesContainer');
        const toggleBtn = document.getElementById('toggleNotesBtn');
        const saveBtn = document.getElementById('saveNotesBtn');
        const notesArea = document.getElementById('userNotes');
        if (!toggleBtn || !notesContainer) return;

        // Hidden by default via CSS; ensure consistent state
        notesContainer.classList.remove('visible');

        // Load notes on init
        try {
            const saved = localStorage.getItem('userNotes');
            if (saved != null && notesArea) notesArea.value = saved;
        } catch(_) {}

        toggleBtn.addEventListener('click', () => {
            notesContainer.classList.toggle('visible');
        });

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                try {
                    const val = (notesArea?.value || '');
                    localStorage.setItem('userNotes', val);
                    // simple feedback
                    const prev = saveBtn.textContent;
                    saveBtn.textContent = 'Saved!';
                    setTimeout(()=>{ saveBtn.textContent = prev; }, 1500);
                } catch(_) {}
            });
        }
    })();
});

