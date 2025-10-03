// --- PHASE 5: FIRESTORE INTEGRATION ---

// This event listener waits for the HTML document to be fully loaded.
document.addEventListener('DOMContentLoaded', () => {

    // Compute API base so it works when opening index.html directly (file://)
    const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : '';

    // Quick backend ping to help users see if server is up
    (async () => {
        try {
            const r = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
            if (!r.ok) throw new Error(`Health status ${r.status}`);
            const j = await r.json();
            console.log('Backend health:', j);
            // Update YouTube banner if enrichment is disabled or in backoff
            try {
                const banner = document.getElementById('yt-banner');
                const yt = j.youtube || {};
                const backoffActive = yt.backoffUntil && Date.now() < yt.backoffUntil;
                if (banner && (!yt.enrichEnabled || backoffActive)) {
                    const when = backoffActive ? ` until ${new Date(yt.backoffUntil).toLocaleTimeString()}` : '';
                    banner.textContent = 'Some lessons may not include videos right now due to YouTube API limits' + when + '.';
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
        userId: null, // We will get this after the user logs in
        timer: {
            intervalId: null,
            timeLeft: 25 * 60,
            isRunning: false,
        }
    };

    // LocalStorage helpers (fallback persistence when no auth/DB)
    const LS_KEYS = {
        lastCourse: 'intelli:lastCourse',
        lastUserId: 'intelli:lastUserId',
        timer: 'intelli:timer',
        streak: 'intelli:streak'
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

    const views = {
        generator: document.getElementById('view-generator'),
        course: document.getElementById('view-course'),
        dashboard: document.getElementById('view-dashboard')
    };
    const resumeBtn = document.getElementById('resume-btn');
    // Auth UI elements
    const signInBtn = document.getElementById('sign-in-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const authModal = document.getElementById('auth-modal');
    const authClose = document.getElementById('auth-close');
    const authTabSignin = document.getElementById('auth-tab-signin');
    const authTabSignup = document.getElementById('auth-tab-signup');
    const authErrorEl = document.getElementById('auth-error');
    const signinForm = document.getElementById('signin-form');
    const signupForm = document.getElementById('signup-form');
    
    const tabButtons = {
        notes: document.getElementById('tab-notes'),
        projects: document.getElementById('tab-projects')
    };
    const contentPanes = {
        notes: document.getElementById('content-notes'),
        projects: document.getElementById('content-projects')
    };
    const userStatusText = document.getElementById('user-status-text');
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


    // --- 3. AUTHENTICATION ---
    // Use anonymous authentication to give each user a unique, persistent ID.
    if (auth && typeof auth.onAuthStateChanged === 'function') {
        auth.onAuthStateChanged(user => {
            if (user) {
                appState.userId = user.uid;
                console.log("User signed in with ID:", appState.userId);
                updateAuthUI(user);
                switchView('dashboard');
                renderDashboard();
                // Clear any anonymous local userId mismatch
                saveToLocal(LS_KEYS.lastUserId, appState.userId);
                // If there is a locally saved course, open it immediately as a resume fallback
                const localCourse = loadFromLocal(LS_KEYS.lastCourse);
                if (localCourse) {
                    loadCourse(localCourse);
                }
                // Load streak and timer state
                loadStreak();
                restoreTimerState();
            } else {
                auth.signInAnonymously().catch(error => {
                    console.error("Anonymous sign-in failed:", error);
                });
            }
        });
    } else {
        // No auth available; stay in generator view and allow generating without a userId
        switchView('generator');
        // Try restore last course if any
        const localCourse = loadFromLocal(LS_KEYS.lastCourse);
        if (localCourse) {
            loadCourse(localCourse);
        }
        // Load timer/streak from local when offline
        loadStreak();
        restoreTimerState();
    }


    // --- 4. CORE FUNCTIONS (REFACTORED FOR FIRESTORE) ---

    const switchView = (viewName) => {
        appState.currentView = viewName;
        Object.values(views).forEach(v => v.classList.add('hidden'));
        if (views[viewName]) {
            views[viewName].classList.remove('hidden');
        }
        if (userStatusText) userStatusText.classList.toggle('hidden', appState.userId === null || viewName === 'generator');
        updateResumeButton();
    };

    function updateAuthUI(user) {
        try {
            const isAnon = !!user?.isAnonymous;
            const email = user?.email || null;
            if (signInBtn) signInBtn.classList.toggle('hidden', !isAnon);
            if (logoutBtn) logoutBtn.classList.toggle('hidden', isAnon);
            if (userStatusText) {
                if (!isAnon && email) {
                    userStatusText.textContent = `Welcome, ${email}`;
                    userStatusText.classList.remove('hidden');
                } else {
                    userStatusText.textContent = 'Welcome, Learner!';
                    // keep default toggle controlled by switchView
                }
            }
        } catch (_) {}
    }

    function openAuthModal(defaultTab = 'signin') {
        if (!authModal) return;
        authModal.classList.remove('hidden');
        setAuthTab(defaultTab);
        clearAuthError();
    }

    function closeAuthModal() {
        if (!authModal) return;
        authModal.classList.add('hidden');
        clearAuthError();
        try {
            const f1 = signinForm; const f2 = signupForm;
            if (f1) f1.reset();
            if (f2) f2.reset();
        } catch (_) {}
    }

    function setAuthTab(tab) {
        if (!authTabSignin || !authTabSignup || !signinForm || !signupForm) return;
        const isSignin = tab === 'signin';
        authTabSignin.classList.toggle('btn-primary', isSignin);
        authTabSignin.classList.toggle('btn-secondary', !isSignin);
        authTabSignup.classList.toggle('btn-primary', !isSignin);
        authTabSignup.classList.toggle('btn-secondary', isSignin);
        signinForm.classList.toggle('hidden', !isSignin);
        signupForm.classList.toggle('hidden', isSignin);
    }

    function showAuthError(msg) {
        if (!authErrorEl) return;
        authErrorEl.textContent = msg || 'Authentication error. Please try again.';
        authErrorEl.classList.remove('hidden');
    }
    function clearAuthError() {
        if (!authErrorEl) return;
        authErrorEl.textContent = '';
        authErrorEl.classList.add('hidden');
    }

    function mapFirebaseAuthError(err) {
        const code = err && err.code ? String(err.code) : '';
        switch (code) {
            case 'auth/operation-not-allowed':
                return 'Email/Password sign-in is disabled for this project. In Firebase Console, enable Authentication → Sign-in method → Email/Password.';
            case 'auth/email-already-in-use':
                return 'This email is already in use. Try signing in instead.';
            case 'auth/invalid-email':
                return 'That email address looks invalid. Please check and try again.';
            case 'auth/weak-password':
                return 'Password is too weak. Use at least 6 characters.';
            case 'auth/wrong-password':
                return 'Incorrect password. Please try again.';
            case 'auth/user-not-found':
                return 'No account found with that email. Try creating an account first.';
            case 'auth/too-many-requests':
                return 'Too many attempts. Please wait a moment and try again.';
            case 'auth/network-request-failed':
                return 'Network error. Check your connection and try again.';
            case 'auth/unauthorized-domain':
                return 'This domain is not authorized. Add your site domain in Firebase Console → Authentication → Settings → Authorized domains.';
            default:
                return (err && err.message) || 'Authentication failed. Please try again.';
        }
    }

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
        if (!appState.userId) return;

        const grid = document.getElementById('dashboard-courses-grid');
        grid.innerHTML = '<p class="text-gray-500">Loading your courses...</p>';

        const coursesRef = db.collection('users').doc(appState.userId).collection('courses');
        
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
                    card.className = 'bg-white rounded-2xl custom-shadow border hover:shadow-xl hover:-translate-y-1 transition-all cursor-pointer flex flex-col';
                    card.dataset.courseId = course.id;

                    const allLessons = (course.modules || []).flatMap(m => m.lessons || []);
                    const completedLessons = allLessons.filter(l => l.completed).length;
                    const progress = allLessons.length > 0 ? Math.round((completedLessons / allLessons.length) * 100) : 0;
                    const ts = Date.parse(course.updatedAt || course.createdAt || 0) || 0;
                    const rel = formatRelativeTime(ts);
                    const notStarted = completedLessons === 0;
                    const done = allLessons.length > 0 && completedLessons === allLessons.length;
                    const statusColor = done ? 'bg-green-500' : (notStarted ? 'bg-gray-300' : 'bg-amber-400');
                    const al = course.activeLesson;
                    let continueText = '';
                    if (al && Number.isInteger(al.moduleIndex) && Number.isInteger(al.lessonIndex)) {
                        const m = course.modules?.[al.moduleIndex];
                        const l = m?.lessons?.[al.lessonIndex];
                        const label = l?.title || `Module ${al.moduleIndex + 1} • Lesson ${al.lessonIndex + 1}`;
                        continueText = `Continue: ${label}`;
                    }

                    card.innerHTML = `
                        <div class="h-32 bg-gradient-to-br from-[#6B8A7A] to-[#8FB09B] rounded-t-2xl"></div>
                        <div class="p-4 flex flex-col flex-grow">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="inline-block w-2.5 h-2.5 rounded-full ${statusColor}"></span>
                                <h3 class="font-bold text-lg flex-grow">${course.title}</h3>
                            </div>
                            <p class="text-sm text-gray-500">${allLessons.length} lessons</p>
                            ${continueText ? `<p class=\"text-xs text-gray-600 mt-0.5\">${continueText}</p>` : ''}
                            <p class="text-xs text-gray-400 mb-2">Last opened ${rel}</p>
                            <div class="w-full bg-gray-200 rounded-full h-2">
                                <div class="bg-gradient-to-r from-[#6B8A7A] to-[#8FB09B] h-2 rounded-full" style="width: ${progress}%"></div>
                            </div>
                            <p class="text-xs text-gray-500 mt-1 self-end">${progress}% Complete</p>
                            <button class="resume-course-btn btn btn-secondary mt-3 w-fit">Resume</button>
                        </div>
                    `;
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
                card.className = 'bg-white rounded-2xl custom-shadow border hover:shadow-xl hover:-translate-y-1 transition-all cursor-pointer flex flex-col';
                card.dataset.courseId = localCourse.id || 'local';
                const allLessons = (localCourse.modules || []).flatMap(m => m.lessons || []);
                const completedLessons = allLessons.filter(l => l.completed).length;
                const progress = allLessons.length ? Math.round((completedLessons / allLessons.length) * 100) : 0;
                card.innerHTML = `
                    <div class="h-32 bg-gradient-to-br from-[#6B8A7A] to-[#8FB09B] rounded-t-2xl"></div>
                    <div class="p-4 flex flex-col flex-grow">
                        <h3 class="font-bold text-lg mb-2 flex-grow">${localCourse.title || 'Resume Last Course'}</h3>
                        <p class="text-sm text-gray-500 mb-3">${allLessons.length} lessons</p>
                        <div class="w-full bg-gray-200 rounded-full h-2">
                            <div class="bg-gradient-to-r from-[#6B8A7A] to-[#8FB09B] h-2 rounded-full" style="width: ${progress}%"></div>
                        </div>
                        <p class="text-xs text-gray-500 mt-1 self-end">${progress}% Complete</p>
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
            let response = await fetch(`${API_BASE}/generate-course`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Send topic and userId when available
                body: JSON.stringify({ topic: topic, userId: appState.userId || null }),
            });

            // Fallback: some versions/routes used /api/generate-course
            if (!response.ok) {
                console.warn('Primary endpoint failed', response.status);
                response = await fetch(`${API_BASE}/api/generate-course`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ topic: topic, userId: appState.userId || null }),
                });
            }

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const courseData = await response.json();
            console.log("Received course from server with ID:", courseData.id, 'saved:', courseData.saved);

            // Client-side fallback save if server couldn't save (e.g., no admin key) and we have userId
            if (!courseData.saved && appState.userId && db) {
                try {
                    await db.collection('users').doc(appState.userId).collection('courses').doc(String(courseData.id)).set({
                        ...courseData,
                        ownerId: appState.userId,
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
            if (card && appState.userId) {
                const courseId = card.dataset.courseId;
                const courseDoc = await db.collection('users').doc(appState.userId).collection('courses').doc(courseId).get();
                if (courseDoc.exists) {
                    loadCourse({ id: courseDoc.id, ...courseDoc.data() });
                    saveToLocal(LS_KEYS.lastCourse, { id: courseDoc.id, ...courseDoc.data() });
                }
            }
            return;
        }
        const card = e.target.closest('[data-course-id]');
        if(card && appState.userId) {
            const courseId = card.dataset.courseId;
            const courseDoc = await db.collection('users').doc(appState.userId).collection('courses').doc(courseId).get();
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
            if (appState.userId) {
                const resp = await fetch(`${API_BASE}/courses/${encodeURIComponent(appState.currentCourse.id)}/complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: appState.userId,
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
            if (db && appState.userId) {
                const ref = db.collection('users').doc(appState.userId).collection('courses').doc(String(appState.currentCourse.id));
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
    if (signInBtn) signInBtn.addEventListener('click', () => openAuthModal('signin'));
    if (logoutBtn) logoutBtn.addEventListener('click', async () => { try { await auth.signOut(); } catch (e) { console.warn('Sign out failed', e); } });
    if (authClose) authClose.addEventListener('click', closeAuthModal);
    if (authTabSignin) authTabSignin.addEventListener('click', () => setAuthTab('signin'));
    if (authTabSignup) authTabSignup.addEventListener('click', () => setAuthTab('signup'));
    if (signinForm) signinForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthError();
        try {
            const email = document.getElementById('signin-email')?.value?.trim();
            const password = document.getElementById('signin-password')?.value;
            if (!email || !password) return showAuthError('Please enter email and password.');
            const user = auth.currentUser;
            const cred = firebase.auth.EmailAuthProvider.credential(email, password);
            if (user && user.isAnonymous) {
                // Try upgrade anonymous account to this email
                try {
                    await user.linkWithCredential(cred);
                    try { await auth.currentUser?.sendEmailVerification(); } catch (_) {}
                    closeAuthModal();
                    return;
                } catch (err) {
                    if (err && (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use')) {
                        // Fall back to sign in (note: previous anon data won't auto-migrate)
                        await auth.signInWithEmailAndPassword(email, password);
                        closeAuthModal();
                        return;
                    }
                    throw err;
                }
            }
            // Regular sign in
            await auth.signInWithEmailAndPassword(email, password);
            closeAuthModal();
        } catch (err) {
            console.warn('Sign in failed:', err);
            showAuthError(mapFirebaseAuthError(err));
        }
    });
    if (signupForm) signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthError();
        try {
            const email = document.getElementById('signup-email')?.value?.trim();
            const password = document.getElementById('signup-password')?.value;
            const confirm = document.getElementById('signup-confirm')?.value;
            if (!email || !password) return showAuthError('Please enter email and password.');
            if (password !== confirm) return showAuthError('Passwords do not match.');
            const user = auth.currentUser;
            const cred = firebase.auth.EmailAuthProvider.credential(email, password);
            if (user && user.isAnonymous) {
                try {
                    await user.linkWithCredential(cred);
                    try { await auth.currentUser?.sendEmailVerification(); } catch (_) {}
                    closeAuthModal();
                    return;
                } catch (err) {
                    if (err && (err.code === 'auth/email-already-in-use' || err.code === 'auth/credential-already-in-use')) {
                        return showAuthError('Email already in use. Please sign in instead.');
                    }
                    throw err;
                }
            }
            await auth.createUserWithEmailAndPassword(email, password);
            try { await auth.currentUser?.sendEmailVerification(); } catch (_) {}
            closeAuthModal();
        } catch (err) {
            console.warn('Sign up failed:', err);
            showAuthError(mapFirebaseAuthError(err));
        }
    });
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
    document.getElementById('timer-start').addEventListener('click', startTimer);
    document.getElementById('timer-pause').addEventListener('click', pauseTimer);
    document.getElementById('timer-reset').addEventListener('click', resetTimer);
    document.getElementById('edit-video-btn').addEventListener('click', () => { /* optional custom logic */ });
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
                const isPaidAndLocked = lesson.type === 'paid' && false; // no premium gating on client
                const icon = isPaidAndLocked
                    ? '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clip-rule="evenodd" /></svg>'
                    : '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg>';
                return `
                    <li data-module-index="${moduleIndex}" data-lesson-index="${lessonIndex}" class="lesson-item cursor-pointer p-3 rounded-xl border-l-4 hover:bg-gray-100 flex items-center gap-3 ${isPaidAndLocked ? 'paid-lesson' : ''}">
                        ${icon}
                        <span class="flex-grow text-sm font-medium">${lesson.title}</span>
                    </li>
                `;
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
        if (db && appState.userId && course.id) {
            try {
                const ref = db.collection('users').doc(appState.userId).collection('courses').doc(String(course.id));
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
            ts: Date.now(),
        });
    }

    function restoreTimerState() {
        const saved = loadFromLocal(LS_KEYS.timer);
        if (!saved) {
            appState.timer.mode = 'work';
            appState.timer.timeLeft = WORK_DURATION;
            appState.timer.isRunning = false;
            updateTimerDisplay();
            return;
        }
        // Basic restore without drift correction for simplicity
        appState.timer.mode = saved.mode || 'work';
        appState.timer.timeLeft = typeof saved.timeLeft === 'number' ? saved.timeLeft : (saved.mode === 'break' ? BREAK_DURATION : WORK_DURATION);
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
        if (appState.timer.timeLeft <= 0) {
            // Auto-switch modes
            appState.timer.mode = appState.timer.mode === 'work' ? 'break' : 'work';
            appState.timer.timeLeft = appState.timer.mode === 'work' ? WORK_DURATION : BREAK_DURATION;
            // Simple feedback
            try { window.navigator.vibrate && window.navigator.vibrate(200); } catch (_) {}
        }
        updateTimerDisplay();
        saveTimerState();
    }

    function startTimer() {
        if (appState.timer.isRunning) return;
        appState.timer.isRunning = true;
        if (!appState.timer.intervalId) {
            appState.timer.intervalId = setInterval(tick, 1000);
        }
        updateTimerDisplay();
        saveTimerState();
    }

    function pauseTimer() {
        appState.timer.isRunning = false;
        updateTimerDisplay();
        saveTimerState();
    }

    function resetTimer() {
        appState.timer.isRunning = false;
        appState.timer.timeLeft = appState.timer.mode === 'work' ? WORK_DURATION : BREAK_DURATION;
        updateTimerDisplay();
        saveTimerState();
    }

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
            if (db && appState.userId) {
                const ref = db.collection('users').doc(appState.userId).collection('meta').doc('streak');
                const snap = await ref.get();
                if (snap.exists) {
                    const data = snap.data() || {};
                    document.getElementById('stat-streak').textContent = `${data.count || 0} 🔥`;
                    saveToLocal(LS_KEYS.streak, data);
                    return;
                }
            }
        } catch (_) {}
        // Fallback to local
        const local = loadFromLocal(LS_KEYS.streak) || { count: 0, last: null };
        document.getElementById('stat-streak').textContent = `${local.count || 0} 🔥`;
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
                current.count = diffDays === 1 ? (current.count + 1) : 1;
            } else {
                current.count = 1;
            }
            current.last = t;
            saveToLocal(LS_KEYS.streak, current);
            document.getElementById('stat-streak').textContent = `${current.count} 🔥`;
            // Persist to Firestore best-effort
            try {
                if (db && appState.userId) {
                    const ref = db.collection('users').doc(appState.userId).collection('meta').doc('streak');
                    await ref.set({ count: current.count, last: current.last }, { merge: true });
                }
            } catch (_) {}
        }
    }
    function renderActivityChart() { /* noop */ }
});

