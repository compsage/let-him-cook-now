const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const path = require('path');

let gifViewProvider = null;
let musicPlayingContext = null;

function activate(context) {
    console.log('🔥🔥🔥 You can cook now 🔥🔥🔥');

    // Create context key for music playing state
    musicPlayingContext = vscode.commands.executeCommand('setContext', 'funnyCookingGifs.musicPlaying', false);

    // Create and register the webview view provider
    gifViewProvider = new GifViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'funnyCookingGifs.gifView',
            gifViewProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Command to get next GIF
    let nextCommand = vscode.commands.registerCommand('funny-cooking-gifs.nextGif', async function () {
        if (gifViewProvider) {
            await gifViewProvider.updateGif();
        }
    });

    // Command to toggle music (play)
    let musicCommand = vscode.commands.registerCommand('funny-cooking-gifs.toggleMusic', async function () {
        console.log('Play button clicked!');
        if (gifViewProvider && gifViewProvider._view) {
            console.log('Sending toggleMusic to webview');
            gifViewProvider._view.webview.postMessage({ command: 'toggleMusic' });
        } else {
            console.error('gifViewProvider or view is null');
            vscode.window.showErrorMessage('Extension not ready. Try reopening the panel.');
        }
    });

    // Command to stop music
    let stopMusicCommand = vscode.commands.registerCommand('funny-cooking-gifs.stopMusic', async function () {
        console.log('Stop button clicked!');
        if (gifViewProvider && gifViewProvider._view) {
            console.log('Sending toggleMusic (stop) to webview');
            gifViewProvider._view.webview.postMessage({ command: 'toggleMusic' });
        }
    });

    context.subscriptions.push(nextCommand);
    context.subscriptions.push(musicCommand);
    context.subscriptions.push(stopMusicCommand);
}

class GifViewProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._view = null;
        this._autoRefreshInterval = null;
        this._currentGifData = null;
    }

    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'getNewGif':
                        await this.updateGif();
                        break;
                    case 'openGiphy':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'getRandomMusic':
                        try {
                            console.log('Fetching random music...');
                            const config = vscode.workspace.getConfiguration('funnyCookingGifs');
                            const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
                            const s3Region = config.get('s3Region', 'us-east-1');
                            const s3MusicPrefix = config.get('s3MusicPrefix', 'songs/');

                            const musicData = await this.fetchRandomMusicFromS3(s3Bucket, s3Region, s3MusicPrefix);

                            if (musicData) {
                                console.log('Sending musicLoaded:', musicData.title);
                                webviewView.webview.postMessage({
                                    command: 'musicLoaded',
                                    musicUrl: musicData.url,
                                    title: musicData.title
                                });
                            } else {
                                console.log('No music files found');
                                webviewView.webview.postMessage({
                                    command: 'musicError',
                                    error: 'No music files found'
                                });
                            }
                        } catch (error) {
                            console.error('Error fetching music:', error);
                            webviewView.webview.postMessage({
                                command: 'musicError',
                                error: 'Failed to load music'
                            });
                        }
                        break;
                    case 'musicStarted':
                        // Update context when music actually starts playing
                        console.log('Music started, setting context to true');
                        vscode.commands.executeCommand('setContext', 'funnyCookingGifs.musicPlaying', true);
                        break;
                    case 'musicStopped':
                        // Update context when music stops
                        console.log('Music stopped, setting context to false');
                        vscode.commands.executeCommand('setContext', 'funnyCookingGifs.musicPlaying', false);
                        break;
                }
            }
        );

        // Handle when the view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.setupAutoRefresh();
            } else {
                this.clearAutoRefresh();
            }
        });

        // Initial load - set HTML once
        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const displayDuration = config.get('displayDuration', 5);
        const autoPlay = config.get('autoPlay', true);
        const panelTitle = config.get('commandTitle', '🔥🔥🔥');

        this._view.webview.html = this.getWebviewContent(panelTitle, displayDuration, autoPlay);

        // Then load first GIF
        this.updateGif();
        this.setupAutoRefresh();
    }

    async updateGif() {
        if (!this._view) return;

        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
        const s3Region = config.get('s3Region', 'us-east-1');
        const s3Prefix = config.get('s3Prefix', 'gifs/');
        const displayDuration = config.get('displayDuration', 5);
        const autoPlay = config.get('autoPlay', true);

        try {
            // Fetch a random GIF from S3
            const gifData = await this.fetchRandomGifFromS3(s3Bucket, s3Region, s3Prefix);

            if (gifData) {
                this._currentGifData = gifData;

                // Send message to update GIF instead of replacing HTML
                this._view.webview.postMessage({
                    command: 'updateGif',
                    gifUrl: gifData.images.original.url,
                    gifId: gifData.id,
                    title: gifData.title || 'Cooking GIF',
                    displayDuration: displayDuration,
                    autoPlay: autoPlay
                });
            } else {
                this._currentGifData = null;
                this._view.webview.postMessage({
                    command: 'gifError',
                    error: 'No GIFs found in S3 bucket.'
                });
            }
        } catch (error) {
            console.error('Error fetching GIF:', error);
            this._view.webview.postMessage({
                command: 'gifError',
                error: 'Failed to load GIF from S3. Check bucket configuration and connection.'
            });
        }
    }

    async fetchRandomFileFromS3(bucket, region, prefix, fileExtensions, formatResponse = null) {
        return new Promise((resolve, reject) => {
            // List objects in S3 bucket using XML API
            const url = `https://${bucket}.s3.${region}.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`;

            https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        // Parse XML response to get list of files
                        const keyMatches = data.match(/<Key>([^<]+)<\/Key>/g);

                        if (!keyMatches || keyMatches.length === 0) {
                            resolve(null);
                            return;
                        }

                        // Extract keys and filter for specified file extensions
                        const fileKeys = keyMatches
                            .map(match => match.replace(/<\/?Key>/g, ''))
                            .filter(key => {
                                const lowerKey = key.toLowerCase();
                                return fileExtensions.some(ext => lowerKey.endsWith(ext.toLowerCase())) && key !== prefix;
                            });

                        if (fileKeys.length === 0) {
                            resolve(null);
                            return;
                        }

                        // Pick a random file
                        const randomKey = fileKeys[Math.floor(Math.random() * fileKeys.length)];
                        const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(randomKey).replace(/%2F/g, '/')}`;

                        // Use custom formatter if provided, otherwise return basic data
                        if (formatResponse) {
                            resolve(formatResponse(randomKey, fileUrl));
                        } else {
                            resolve({
                                url: fileUrl,
                                key: randomKey,
                                title: randomKey.split('/').pop()
                            });
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    async fetchRandomGifFromS3(bucket, region, prefix) {
        return this.fetchRandomFileFromS3(bucket, region, prefix, ['.gif'], (randomKey, fileUrl) => {
            // Create a GIF data object similar to Giphy format
            return {
                id: randomKey,
                title: randomKey.split('/').pop().replace('.gif', ''),
                images: {
                    original: {
                        url: fileUrl
                    }
                }
            };
        });
    }

    async fetchRandomMusicFromS3(bucket, region, prefix) {
        return this.fetchRandomFileFromS3(bucket, region, prefix, ['.mp3'], (randomKey, fileUrl) => {
            // Return music URL
            return {
                url: fileUrl,
                title: randomKey.split('/').pop().replace('.mp3', '')
            };
        });
    }

    setupAutoRefresh() {
        this.clearAutoRefresh();

        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const displayDuration = config.get('displayDuration', 5);
        const autoPlay = config.get('autoPlay', true);

        if (autoPlay && this._view && this._view.visible) {
            const intervalMs = displayDuration * 1000;
            this._autoRefreshInterval = setInterval(() => {
                this.updateGif();
            }, intervalMs);
        }
    }

    clearAutoRefresh() {
        if (this._autoRefreshInterval) {
            clearInterval(this._autoRefreshInterval);
            this._autoRefreshInterval = null;
        }
    }

    getWebviewContent(panelTitle, displayDuration, autoPlay) {
        // Read the HTML template file
        const htmlPath = path.join(__dirname, 'webview.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // Replace template placeholders
        html = html.replace(/\{\{panelTitle\}\}/g, panelTitle);
        html = html.replace(/\{\{displayDuration\}\}/g, displayDuration.toString());
        html = html.replace(/\{\{countdownBar\}\}/g,
            autoPlay ? `<div class="countdown-bar" id="countdownBar"></div>` : ''
        );

        return html;
    }
}

function deactivate() {
    if (gifViewProvider) {
        gifViewProvider.clearAutoRefresh();
    }
}

module.exports = {
    activate,
    deactivate
}
