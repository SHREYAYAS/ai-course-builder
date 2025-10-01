document.addEventListener('DOMContentLoaded', () => {

    // --- PHASE 1 & 3: APP STATE (MOCK DATA REMOVED) ---

    const appState = {
        currentView: 'generator',
        currentCourse: null,
        user: {
            isPremium: false,
            streak: 12,
            savedCourses: [], // This will now be populated by API calls
            activity: [5, 3, 6, 4, 7, 2, 5] 
        },
        timer: {
            intervalId: null,
            timeLeft: 25 * 60,
            isRunning: false,
        }
    };
    
    // MOCK DATABASE HAS BEEN MOVED TO server.js

    // --- PHASE 2: DOM ELEMENT REFERENCES (No Changes) ---

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

    // --- PHASE 2: CORE FUNCTIONS (No Changes) ---

    const switchView = (viewName) => {
        appState.currentView = viewName;
        Object.values(views).forEach(v => v.classList.add('hidden'));
        if (views[viewName]) {
            views[viewName].classList.remove('hidden');
        }
        userStatusText.classList.toggle('hidden', viewName === 'generator');
    };
    
    const switchTab = (tabName) => {
         Object.values(tabButtons).forEach(b => {
            b.classList.remove('text-[#5A7D6C]', 'border-[#6B8A7A]');
            b.classList.add('text-gray-500', 'border-transparent');
        });
        Object.values(contentPanes).forEach(p => p.classList.add('hidden'));

        tabButtons[tabName].classList.add('text-[#5A7D6C]', 'border-[#6B8A7A]');
        tabButtons[tabName].classList.remove('text-gray-500', 'border-transparent');
        contentPanes[tabName].classList.remove('hidden');
    };

    const renderSyllabus = (course) => {
        const container = document.getElementById('syllabus-container');
        container.innerHTML = '';
        course.modules.forEach((module, moduleIndex) => {
            const moduleEl = document.createElement('div');
            const lessonsHtml = module.lessons.map((lesson, lessonIndex) => {
                const isPaidAndLocked = lesson.type === 'paid' && !appState.user.isPremium;
                const icon = isPaidAndLocked 
                    ? `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clip-rule="evenodd" /></svg>`
                    : `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg>`;
                
                return `
                    <li data-module-index="${moduleIndex}" data-lesson-index="${lessonIndex}" class="lesson-item cursor-pointer p-3 rounded-xl border-l-4 ${lesson.completed ? 'border-green-300' : 'border-transparent'} hover:bg-gray-100 flex items-center gap-3 ${isPaidAndLocked ? 'paid-lesson' : ''}">
                        ${icon}
                        <span class="flex-grow text-sm font-medium">${lesson.title}</span>
                        ${lesson.completed ? '<span class="text-green-500">✔</span>' : ''}
                    </li>
                `;
            }).join('');

            moduleEl.innerHTML = `
                <h3 class="font-bold text-md mb-2 px-2">${module.title}</h3>
                <ul class="space-y-1">${lessonsHtml}</ul>
            `;
            container.appendChild(moduleEl);
        });
    };

    const updateCourseProgress = (course) => {
        const allLessons = course.modules.flatMap(m => m.lessons);
        const completedLessons = allLessons.filter(l => l.completed).length;
        const totalLessons = allLessons.length;
        const progress = totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0;
        
        document.getElementById('course-progress-bar').style.width = `${progress}%`;
        document.getElementById('course-progress-text').textContent = `${Math.round(progress)}% Complete (${completedLessons}/${totalLessons} lessons)`;
    };

    const loadLesson = (course, moduleIndex, lessonIndex) => {
        const lesson = course.modules[moduleIndex].lessons[lessonIndex];
        const contentNotes = document.getElementById('content-notes');
        const markCompleteBtn = document.getElementById('mark-complete-btn');
        const videoContainer = document.getElementById('video-container');

        document.getElementById('lesson-title').textContent = lesson.title;

        if (lesson.type === 'paid' && !appState.user.isPremium) {
            videoContainer.innerHTML = `
                <div class="text-center p-8 bg-gray-50 rounded-lg w-full h-full flex flex-col justify-center items-center">
                    <span class="text-4xl">🔒</span>
                    <h3 class="text-xl font-bold mt-4">This is a Premium Lesson</h3>
                    <p class="text-gray-600 mt-2 max-w-sm">Upgrade to IntelliCourse Premium to unlock this lesson, advanced project ideas, exclusive notes, and more.</p>
                    <button class="mt-4 btn btn-premium">Upgrade Now</button>
                </div>
            `;
            contentNotes.innerHTML = '';
            markCompleteBtn.style.display = 'none';
        } else {
            videoContainer.innerHTML = `<iframe id="video-player" class="w-full h-full" src="https://www.youtube.com/embed/${lesson.videoId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
            contentNotes.innerHTML = lesson.notes;
            markCompleteBtn.style.display = 'inline-flex';
            markCompleteBtn.querySelector('span').textContent = lesson.completed ? 'Completed' : 'Mark as Complete';
            markCompleteBtn.disabled = lesson.completed;
        }
        
        document.getElementById('content-projects').innerHTML = course.projectIdeas;
        appState.currentCourse.activeLesson = { moduleIndex, lessonIndex };

        document.querySelectorAll('.lesson-item').forEach(el => el.classList.remove('active-lesson'));
        const activeLessonEl = document.querySelector(`.lesson-item[data-module-index="${moduleIndex}"][data-lesson-index="${lessonIndex}"]`);
        if(activeLessonEl) activeLessonEl.classList.add('active-lesson');
    };

    const loadCourse = (course) => {
        appState.currentCourse = JSON.parse(JSON.stringify(course)); 
        // Add course to saved courses if it's not already there
        if (!appState.user.savedCourses.find(c => c.id === course.id)) {
            appState.user.savedCourses.push(appState.currentCourse);
        }
        document.getElementById('course-title-sidebar').textContent = appState.currentCourse.title;
        renderSyllabus(appState.currentCourse);
        updateCourseProgress(appState.currentCourse);
        loadLesson(appState.currentCourse, 0, 0);
        document.getElementById('streak-counter').textContent = appState.user.streak;
        switchView('course');
        switchTab('notes');
    };

    const renderDashboard = () => {
        const grid = document.getElementById('dashboard-courses-grid');
        grid.innerHTML = '';
        
        if (appState.user.savedCourses.length === 0) {
            grid.innerHTML = `<p class="text-gray-500 md:col-span-3 text-center">You haven't generated any courses yet. Go create one!</p>`;
        }
        
        const totalLessonsCompleted = appState.user.savedCourses.reduce((acc, course) => {
            return acc + course.modules.flatMap(m => m.lessons).filter(l => l.completed).length;
        }, 0);

        document.getElementById('stat-courses').textContent = appState.user.savedCourses.length;
        document.getElementById('stat-lessons').textContent = totalLessonsCompleted;
        document.getElementById('stat-streak').textContent = `${appState.user.streak} 🔥`;

        appState.user.savedCourses.forEach(course => {
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
        renderActivityChart();
    };
    
    let activityChartInstance = null;
    const renderActivityChart = () => {
        const ctx = document.getElementById('activityChart').getContext('2d');
        if (activityChartInstance) {
            activityChartInstance.destroy();
        }
        activityChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['6 days ago', '5 days ago', '4 days ago', '3 days ago', '2 days ago', 'Yesterday', 'Today'],
                datasets: [{
                    label: 'Lessons Completed',
                    data: appState.user.activity,
                    backgroundColor: '#8FB09B',
                    hoverBackgroundColor: '#6B8A7A',
                    borderRadius: 6,
                    borderWidth: 0,
                    barThickness: 20,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        displayColors: false,
                        backgroundColor: '#3F4A42',
                        titleFont: { size: 14, weight: 'bold' },
                        bodyFont: { size: 12 },
                        padding: 12,
                        cornerRadius: 8,
                        callbacks: {
                            label: context => `${context.parsed.y} lessons completed`
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { drawBorder: false },
                        ticks: { stepSize: 2, color: '#9ca3af' }
                    },
                    x: { 
                        grid: { display: false },
                        ticks: { color: '#9ca3af' }
                    }
                }
            }
        });
    };

    const updateTimerDisplay = () => {
        const minutes = Math.floor(appState.timer.timeLeft / 60).toString().padStart(2, '0');
        const seconds = (appState.timer.timeLeft % 60).toString().padStart(2, '0');
        document.getElementById('timer-display').textContent = `${minutes}:${seconds}`;
    };
    
    const startTimer = () => {
        if(appState.timer.isRunning) return;
        appState.timer.isRunning = true;
        appState.timer.intervalId = setInterval(() => {
            appState.timer.timeLeft--;
            updateTimerDisplay();
            if(appState.timer.timeLeft <= 0) {
                clearInterval(appState.timer.intervalId);
                appState.timer.isRunning = false;
                console.log("Time's up! Take a break.");
                resetTimer();
            }
        }, 1000);
    };

    const pauseTimer = () => {
        clearInterval(appState.timer.intervalId);
        appState.timer.isRunning = false;
    };

    const resetTimer = () => {
        clearInterval(appState.timer.intervalId);
        appState.timer.isRunning = false;
        appState.timer.timeLeft = 25 * 60;
        updateTimerDisplay();
    };

    // --- PHASE 3: EVENT LISTENERS (Updated) ---

    document.getElementById('home-logo').addEventListener('click', () => {
        switchView('generator');
    });

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
            // Use the 'fetch' API to send a POST request to our new backend
            const response = await fetch('http://localhost:3000/generate-course', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ topic: topic }), // Send the topic in the request body
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const courseData = await response.json(); // Get the course data from the server's response
            loadCourse(courseData);

        } catch (error) {
            console.error("Could not fetch course:", error);
            alert("Failed to generate course. Is the backend server running?");
        } finally {
            // Always hide the loading indicator
            loadingIndicator.classList.add('hidden');
        }
    });

    document.getElementById('dashboard-btn').addEventListener('click', () => {
        renderDashboard();
        switchView('dashboard');
    });
    
    document.getElementById('create-new-course-btn').addEventListener('click', () => {
        switchView('generator');
    });

    document.getElementById('syllabus-container').addEventListener('click', (e) => {
        const lessonItem = e.target.closest('.lesson-item');
        if (lessonItem) {
            const moduleIndex = parseInt(lessonItem.dataset.moduleIndex);
            const lessonIndex = parseInt(lessonItem.dataset.lessonIndex);
            loadLesson(appState.currentCourse, moduleIndex, lessonIndex);
        }
    });
    
    document.getElementById('dashboard-courses-grid').addEventListener('click', (e) => {
        const card = e.target.closest('[data-course-id]');
        if(card) {
            const course = appState.user.savedCourses.find(c => c.id === card.dataset.courseId);
            if(course) loadCourse(course);
        }
    });

    document.getElementById('mark-complete-btn').addEventListener('click', (e) => {
        if (!appState.currentCourse || appState.currentCourse.activeLesson === null) return;
        const { moduleIndex, lessonIndex } = appState.currentCourse.activeLesson;
        const lesson = appState.currentCourse.modules[moduleIndex].lessons[lessonIndex];
        if (!lesson.completed) {
            lesson.completed = true;
            e.currentTarget.querySelector('span').textContent = 'Completed';
            e.currentTarget.disabled = true;
            renderSyllabus(appState.currentCourse);
            updateCourseProgress(appState.currentCourse);
            
            const activeLessonEl = document.querySelector(`.lesson-item[data-module-index="${moduleIndex}"][data-lesson-index="${lessonIndex}"]`);
            if(activeLessonEl) activeLessonEl.classList.add('active-lesson');
        }
    });
    
    tabButtons.notes.addEventListener('click', () => switchTab('notes'));
    tabButtons.projects.addEventListener('click', () => switchTab('projects'));
    
    document.getElementById('timer-start').addEventListener('click', startTimer);
    document.getElementById('timer-pause').addEventListener('click', pauseTimer);
    document.getElementById('timer-reset').addEventListener('click', resetTimer);

});
