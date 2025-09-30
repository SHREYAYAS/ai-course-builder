document.addEventListener('DOMContentLoaded', () => {

    // --- PHASE 1: MOCK DATA & APP STATE ---

    const appState = {
        currentView: 'generator',
        currentCourse: null,
        user: {
            isPremium: false,
            streak: 12,
            savedCourses: [],
            activity: [5, 3, 6, 4, 7, 2, 5] 
        },
        timer: {
            intervalId: null,
            timeLeft: 25 * 60,
            isRunning: false,
        }
    };

    const mockCourseData = {
        id: 'python-ai-101',
        title: 'Learn Python with AI',
        modules: [
            {
                title: 'Module 1: Python Fundamentals',
                lessons: [
                    { id: 'p1', title: 'Introduction to Python', videoId: 'kqtD5dpn9C8', completed: true, type: 'free', notes: '<h3>What is Python?</h3><p>Python is a high-level, interpreted programming language known for its simple syntax and readability. It\'s widely used in web development, data science, AI, and more.</p><h4>Key Features:</h4><ul><li>Easy to learn</li><li>Large standard library</li><li>Dynamically typed</li></ul>' },
                    { id: 'p2', title: 'Variables and Data Types', videoId: 'g2gZz-w_j1s', completed: true, type: 'free', notes: '<h3>Variables</h3><p>Variables are containers for storing data values. In Python, you don\'t need to declare the type of a variable.</p><h4>Common Data Types:</h4><ul><li><b>int:</b> Integer numbers (e.g., 5, -10)</li><li><b>float:</b> Floating-point numbers (e.g., 3.14)</li><li><b>str:</b> Strings (e.g., "Hello")</li><li><b>bool:</b> Boolean values (True, False)</li></ul><pre><code>name = "Alice"\nage = 30\npi = 3.14159</code></pre>' },
                    { id: 'p3', title: 'Lists, Tuples, and Dictionaries', videoId: 'R-HLU9A_g_4', completed: false, type: 'paid', notes: '<h3>Advanced Collections</h3><p>This premium lesson covers advanced usage of collections, including list comprehensions and dictionary methods.</p><h4>Exclusive Content:</h4><ul><li>Performance comparisons</li><li>Advanced code snippets</li><li>Expert Q&A section</li></ul>' }
                ]
            },
            {
                title: 'Module 2: Control Flow & Functions',
                lessons: [
                    { id: 'p4', title: 'Conditional Statements (if/else)', videoId: 'DZwmZ8Usvnk', completed: false, type: 'free', notes: '<h3>Making Decisions</h3><p>Conditional statements allow you to execute code blocks based on certain conditions.</p><pre><code>age = 18\nif age >= 18:\n  print("You are an adult.")\nelse:\n  print("You are a minor.")</code></pre>' },
                    { id: 'p5', title: 'Loops (for/while)', videoId: 'OnDr4J2qL0g', completed: false, type: 'paid', notes: '<h3>Mastering Loops</h3><p>Go beyond the basics with nested loops, break/continue statements, and the else clause in loops.</p><h4>Exclusive Content:</h4><ul><li>Complex looping patterns</li><li>Common pitfalls to avoid</li><li>Downloadable cheat sheet</li></ul>' }
                ]
            }
        ],
        projectIdeas: '<h3>Project 1: Personal Blog Aggregator (Free)</h3><p>Create a web application that scrapes and displays recent posts from a list of your favorite blogs. Use Python with libraries like BeautifulSoup for scraping and Flask for the web backend.</p><hr class="my-4"><h3>Project 2: Sentiment Analysis Tool (Premium)</h3><p>Build a tool that analyzes the sentiment (positive, negative, neutral) of a piece of text. You can use a pre-trained AI model from libraries like NLTK or TextBlob. Premium includes a starter code repository.</p>'
    };
    
    appState.user.savedCourses.push(mockCourseData);
    appState.user.savedCourses.push({
        id: 'js-webdev-101',
        title: 'JavaScript for Web Development',
        modules: [{ title: 'Module 1: JS Basics', lessons: [{id: 'j1', title: 'Intro', videoId: 'hdI2bqOjy3c', completed: true, type: 'free'}]}],
        projectIdeas: '<p>Build an interactive To-Do list application.</p>'
    });

    // --- PHASE 2: DOM ELEMENT REFERENCES ---

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

    // --- PHASE 2: CORE FUNCTIONS ---

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
                // Replace alert with a more subtle notification if possible in a real app
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

    // --- PHASE 2: EVENT LISTENERS ---

    document.getElementById('home-logo').addEventListener('click', () => {
        switchView('generator');
    });

    document.getElementById('generate-course-btn').addEventListener('click', () => {
        if(document.getElementById('topic-input').value.trim() === '') {
             document.getElementById('topic-input').focus();
            return;
        }
        document.getElementById('loading-indicator').classList.remove('hidden');
        setTimeout(() => {
            document.getElementById('loading-indicator').classList.add('hidden');
            loadCourse(mockCourseData);
        }, 1500);
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
            
            // Re-highlight the active lesson after re-render
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
