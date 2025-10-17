const https = require('https');

const bucket = 'let-them-cook-now';
const region = 'us-east-1';
const gifsPrefix = 'gifs/';
const songsPrefix = 'songs/';

function testS3Bucket(prefix, fileType) {
    return new Promise((resolve, reject) => {
        const url = `https://${bucket}.s3.${region}.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`;

        console.log(`\nTesting ${fileType}...`);
        console.log(`URL: ${url}\n`);

        https.get(url, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                console.log(`Status Code: ${res.statusCode}`);

                if (res.statusCode !== 200) {
                    console.log('Error: Bucket not accessible or doesn\'t exist');
                    console.log('Response:', data);
                    resolve({ success: false, error: 'HTTP ' + res.statusCode });
                    return;
                }

                try {
                    // Parse XML response
                    const keyMatches = data.match(/<Key>([^<]+)<\/Key>/g);

                    if (!keyMatches || keyMatches.length === 0) {
                        console.log(`❌ No files found with prefix "${prefix}"`);
                        resolve({ success: false, error: 'No files found' });
                        return;
                    }

                    // Extract keys
                    const keys = keyMatches.map(match => match.replace(/<\/?Key>/g, ''));

                    console.log(`✓ Found ${keys.length} total items`);
                    console.log('\nAll items:');
                    keys.forEach(key => console.log(`  - ${key}`));

                    // Filter for specific file type
                    const filteredKeys = keys.filter(key =>
                        key.toLowerCase().endsWith(fileType) && key !== prefix
                    );

                    console.log(`\n✓ Found ${filteredKeys.length} ${fileType.toUpperCase()} files`);
                    if (filteredKeys.length > 0) {
                        console.log('\nFiles:');
                        filteredKeys.forEach(key => {
                            const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
                            console.log(`  - ${key}`);
                            console.log(`    URL: ${url}`);
                        });

                        // Test if first file is accessible
                        const testUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(filteredKeys[0]).replace(/%2F/g, '/')}`;
                        console.log(`\nTesting if first file is accessible...`);
                        https.get(testUrl, (testRes) => {
                            console.log(`Test Status Code: ${testRes.statusCode}`);
                            if (testRes.statusCode === 200) {
                                console.log('✓ File is publicly accessible!');
                            } else if (testRes.statusCode === 403) {
                                console.log('❌ File exists but is not publicly accessible (403 Forbidden)');
                            } else {
                                console.log(`❌ Unexpected status: ${testRes.statusCode}`);
                            }
                            testRes.on('data', () => {}); // Consume response
                            resolve({ success: filteredKeys.length > 0 });
                        }).on('error', (err) => {
                            console.log('❌ Error accessing file:', err.message);
                            resolve({ success: false, error: err.message });
                        });
                    } else {
                        console.log(`❌ No ${fileType.toUpperCase()} files found in prefix "${prefix}"`);
                        resolve({ success: false, error: `No ${fileType} files found` });
                    }
                } catch (e) {
                    console.log('❌ Error parsing response:', e.message);
                    console.log('Raw response:', data.substring(0, 500));
                    resolve({ success: false, error: e.message });
                }
            });
        }).on('error', (err) => {
            console.log('❌ Network error:', err.message);
            resolve({ success: false, error: err.message });
        });
    });
}

async function runTests() {
    console.log('='.repeat(60));
    console.log('S3 Bucket Configuration Test');
    console.log('='.repeat(60));
    console.log(`Bucket: ${bucket}`);
    console.log(`Region: ${region}`);
    console.log('='.repeat(60));

    // Test GIFs
    const gifsResult = await testS3Bucket(gifsPrefix, '.gif');

    console.log('\n' + '='.repeat(60));

    // Test Songs
    const songsResult = await testS3Bucket(songsPrefix, '.mp3');

    console.log('\n' + '='.repeat(60));
    console.log('\nSummary:');
    console.log(`GIFs: ${gifsResult.success ? '✓ OK' : '❌ ' + gifsResult.error}`);
    console.log(`Songs: ${songsResult.success ? '✓ OK' : '❌ ' + songsResult.error}`);
    console.log('='.repeat(60));
}

runTests();
