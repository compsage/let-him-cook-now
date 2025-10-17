// Test script to verify GIPHY API call
const https = require('https');

const apiKey = '0hzsX6SOMLCB45KGf00fk8ULUQY0NDmo';
const searchTerm = 'funny cooking fail';
const rating = 'pg';
const limit = 10;
const offset = Math.floor(Math.random() * 100);

const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(searchTerm)}&limit=${limit}&offset=${offset}&rating=${rating}&lang=en`;

console.log('Testing GIPHY API call...');
console.log('URL:', url.replace(apiKey, 'API_KEY_HIDDEN'));
console.log('');

https.get(url, (res) => {
    let data = '';

    console.log('Status Code:', res.statusCode);
    console.log('');

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        try {
            const json = JSON.parse(data);

            console.log('Response Meta:');
            console.log('  Status:', json.meta?.status);
            console.log('  Message:', json.meta?.msg);
            console.log('');

            if (json.data && json.data.length > 0) {
                console.log('✓ Success! Found', json.data.length, 'GIFs');
                console.log('');

                // Test the first GIF object structure
                const firstGif = json.data[0];
                console.log('First GIF data:');
                console.log('  ID:', firstGif.id);
                console.log('  Title:', firstGif.title);
                console.log('  URL:', firstGif.url);
                console.log('  Rating:', firstGif.rating);
                console.log('');

                console.log('Image URLs available:');
                console.log('  Original URL:', firstGif.images?.original?.url || 'NOT FOUND');
                console.log('  Original Width:', firstGif.images?.original?.width);
                console.log('  Original Height:', firstGif.images?.original?.height);
                console.log('  Fixed Height URL:', firstGif.images?.fixed_height?.url || 'NOT FOUND');
                console.log('  Fixed Width URL:', firstGif.images?.fixed_width?.url || 'NOT FOUND');
                console.log('');

                // Test analytics object
                if (firstGif.analytics) {
                    console.log('✓ Analytics object present');
                } else {
                    console.log('✗ Analytics object missing');
                }
                console.log('');

                console.log('✓ API call structure is correct and working!');
            } else {
                console.log('✗ No GIFs found in response');
                console.log('Response data:', json.data);
            }
        } catch (e) {
            console.error('✗ Error parsing JSON:', e.message);
            console.error('Raw response:', data.substring(0, 500));
        }
    });
}).on('error', (err) => {
    console.error('✗ HTTPS request error:', err.message);
});
