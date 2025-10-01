// --- PHASE 5: FIRESTORE INTEGRATION ---

// This event listener waits for the HTML document to be fully loaded.
document.addEventListener('DOMContentLoaded', () => {

    // Compute API base so it works when opening index.html directly (file://)
    const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : '';

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
            const response = await fetch(`${API_BASE}/generate-course`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Send topic and userId when available
                body: JSON.stringify({ topic: topic, userId: appState.userId || null }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const courseData = await response.json();
            
            // The server now saves the course to Firestore.
            // We just need to load the course data the server sends back.
            console.log("Received course from server with ID:", courseData.id);
            loadCourse(courseData);

        } catch (error) {
            console.error("Could not generate course:", error);
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

    // --- Unchanged Event Listeners & Helper Functions ---
    // (The rest of the file remains the same)
    document.getElementById('home-logo').addEventListener('click', () => switchView('generator'));
    document.getElementById('dashboard-btn').addEventListener('click', () => { switchView('dashboard'); });
    document.getElementById('create-new-course-btn').addEventListener('click', () => switchView('generator'));
    tabButtons.notes.addEventListener('click', () => switchTab('notes'));
    tabButtons.projects.addEventListener('click', () => switchTab('projects'));
    document.getElementById('timer-start').addEventListener('click', startTimer);
    document.getElementById('timer-pause').addEventListener('click', pauseTimer);
    document.getElementById('timer-reset').addEventListener('click', resetTimer);
    document.getElementById('edit-video-btn').addEventListener('click', () => { /* Logic from Phase 5 Guide */ });

    function renderSyllabus(course) { /* Unchanged */ }
    function updateCourseProgress(course) { /* Unchanged */ }
    function loadLesson(course, moduleIndex, lessonIndex) { /* Unchanged */ }
    function updateTimerDisplay() { /* Unchanged */ }
    function startTimer() { /* Unchanged */ }
    function pauseTimer() { /* Unchanged */ }
    function resetTimer() { /* Unchanged */ }
    function renderActivityChart() { /* Unchanged */ }
});

