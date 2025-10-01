// Simple test to verify the backend is working
const http = require('http');

const postData = JSON.stringify({
    topic: 'JavaScript'
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/generate-course',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    }
};

const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers: ${JSON.stringify(res.headers)}`);
    
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        try {
            const courseData = JSON.parse(data);
            console.log('✅ Backend test successful!');
            console.log('Course title:', courseData.title);
            console.log('Number of modules:', courseData.modules.length);
            console.log('Total lessons:', courseData.modules.reduce((acc, mod) => acc + mod.lessons.length, 0));
        } catch (error) {
            console.log('❌ Failed to parse response:', data);
        }
    });
});

req.on('error', (e) => {
    console.error(`❌ Request failed: ${e.message}`);
});

req.write(postData);
req.end();