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

    const views = {
        generator: document.getElementById('view-generator'),
        course: document.getElementById('view-course'),
        dashboard: document.getElementById('view-dashboard')
    };
    
    const tabButtons = {
        notes: document.getElementById('tab-notes'),
        projects: document.getElementById('tab-projects')
    };
    const contentPanes = {
        notes: document.getElementById('content-notes'),
        projects: document.getElementById('content-projects')
    };
    const userStatusText = document.getElementById('user-status-text');


    // --- 3. AUTHENTICATION ---
    // Use anonymous authentication to give each user a unique, persistent ID.
    if (auth && typeof auth.onAuthStateChanged === 'function') {
        auth.onAuthStateChanged(user => {
            if (user) {
                appState.userId = user.uid;
                console.log("User signed in with ID:", appState.userId);
                switchView('dashboard');
                renderDashboard();
            } else {
                auth.signInAnonymously().catch(error => {
                    console.error("Anonymous sign-in failed:", error);
                });
            }
        });
    } else {
        // No auth available; stay in generator view and allow generating without a userId
        switchView('generator');
    }


    // --- 4. CORE FUNCTIONS (REFACTORED FOR FIRESTORE) ---

    const switchView = (viewName) => {
        appState.currentView = viewName;
        Object.values(views).forEach(v => v.classList.add('hidden'));
        if (views[viewName]) {
            views[viewName].classList.remove('hidden');
        }
        userStatusText.classList.toggle('hidden', appState.userId === null || viewName === 'generator');
    };

    const loadCourse = (course) => {
        appState.currentCourse = course; 
        document.getElementById('course-title-sidebar').textContent = appState.currentCourse.title;
        renderSyllabus(appState.currentCourse);
        updateCourseProgress(appState.currentCourse);
        loadLesson(appState.currentCourse, 0, 0);
        switchView('course');
        switchTab('notes');
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

            grid.innerHTML = ''; 

            if (courses.length === 0) {
                grid.innerHTML = `<div class="md:col-span-3 text-center p-8 bg-gray-50 rounded-2xl"><h3 class="text-lg font-semibold">Welcome!</h3><p class="text-gray-500 mt-2">You haven't generated any courses yet. Go create one to get started!</p></div>`;
            } else {
                 courses.forEach(course => {
                    const card = document.createElement('div');
                    card.className = 'bg-white rounded-2xl custom-shadow border hover:shadow-xl hover:-translate-y-1 transition-all cursor-pointer flex flex-col';
                    card.dataset.courseId = course.id;

                    const allLessons = course.modules.flatMap(m => m.lessons);
                    const completedLessons = allLessons.filter(l => l.completed).length;
                    const progress = allLessons.length > 0 ? Math.round((completedLessons / allLessons.length) * 100) : 0;

                    card.innerHTML = `
                        <div class="h-32 bg-gradient-to-br from-[#6B8A7A] to-[#8FB09B] rounded-t-2xl"></div>
                        <div class="p-4 flex flex-col flex-grow">
                            <h3 class="font-bold text-lg mb-2 flex-grow">${course.title}</h3>
                            <p class="text-sm text-gray-500 mb-3">${allLessons.length} lessons</p>
                            <div class="w-full bg-gray-200 rounded-full h-2">
                                <div class="bg-gradient-to-r from-[#6B8A7A] to-[#8FB09B] h-2 rounded-full" style="width: ${progress}%"></div>
                            </div>
                            <p class="text-xs text-gray-500 mt-1 self-end">${progress}% Complete</p>
                        </div>
                    `;
                    grid.appendChild(card);
                });
            }
        }, error => {
            console.error("Error fetching courses: ", error);
            grid.innerHTML = `<p class="text-red-500 md:col-span-3 text-center">Could not load courses. Please check your connection and Firestore security rules.</p>`;
        });
        
        // Stats will be updated via a separate listener later for more complex scenarios
        document.getElementById('stat-courses').textContent = '...';
        document.getElementById('stat-lessons').textContent = '...';
        document.getElementById('stat-streak').textContent = '... 🔥';
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
            
            // The server now saves the course to Firestore.
            // We just need to load the course data the server sends back.
            console.log("Received course from server with ID:", courseData.id);
            loadCourse(courseData);

        } catch (error) {
            console.error("Could not generate course:", error);
            console.error('Hint: ensure the backend is running (npm start) and open http://localhost:3000, not the file path.');
            alert("Failed to generate course. Please check that your backend and AI services are running correctly.");
        } finally {
            loadingIndicator.classList.add('hidden');
        }
    });

    document.getElementById('dashboard-courses-grid').addEventListener('click', async (e) => {
        const card = e.target.closest('[data-course-id]');
        if(card && appState.userId) {
            const courseId = card.dataset.courseId;
            const courseDoc = await db.collection('users').doc(appState.userId).collection('courses').doc(courseId).get();
            if (courseDoc.exists) {
                loadCourse({ id: courseDoc.id, ...courseDoc.data() });
            } else {
                console.error("Could not find the clicked course in the database.");
            }
        }
    });

    document.getElementById('mark-complete-btn').addEventListener('click', async (e) => {
        if (!appState.currentCourse || !appState.userId) return;

        const { moduleIndex, lessonIndex } = appState.currentCourse.activeLesson;
        const courseRef = db.collection('users').doc(appState.userId).collection('courses').doc(appState.currentCourse.id);
        
        try {
            const courseDoc = await courseRef.get();
            if (courseDoc.exists) {
                const courseData = courseDoc.data();
                const lesson = courseData.modules[moduleIndex].lessons[lessonIndex];
                
                if (!lesson.completed) {
                    lesson.completed = true;
                    await courseRef.set(courseData);
                    
                    appState.currentCourse = courseData; // Update local state
                    renderSyllabus(appState.currentCourse);
                    updateCourseProgress(appState.currentCourse);
                    e.currentTarget.querySelector('span').textContent = 'Completed';
                    e.currentTarget.disabled = true;
                }
            }
        } catch (error) {
            console.error("Error updating lesson status:", error);
            alert("Could not update lesson status. Please try again.");
        }
    });

    // --- Event Listeners ---
    document.getElementById('home-logo').addEventListener('click', () => switchView('generator'));
    document.getElementById('dashboard-btn').addEventListener('click', () => { switchView('dashboard'); });
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
        markCompleteBtn.disabled = !!lesson.completed;
        course.activeLesson = { moduleIndex, lessonIndex };
        document.querySelectorAll('.lesson-item').forEach(el => el.classList.remove('active-lesson'));
        const activeLessonEl = document.querySelector(`.lesson-item[data-module-index="${moduleIndex}"][data-lesson-index="${lessonIndex}"]`);
        if (activeLessonEl) activeLessonEl.classList.add('active-lesson');
        document.getElementById('content-projects').innerHTML = course.projectIdeas || '';
    }

    // Timer helpers (minimal)
    function updateTimerDisplay() { /* noop */ }
    function startTimer() { /* noop */ }
    function pauseTimer() { /* noop */ }
    function resetTimer() { /* noop */ }
    function renderActivityChart() { /* noop */ }
});

