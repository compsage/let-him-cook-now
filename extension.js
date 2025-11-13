const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const path = require('path');

let gifViewProvider = null;

function activate(context) {
    console.log('🔥🔥🔥 You can cook now 🔥🔥🔥');

    // Initialize context key for music playing state
    vscode.commands.executeCommand('setContext', 'funnyCookingGifs.musicPlaying', false);

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
    const ensureViewReady = () => {
        if (gifViewProvider && gifViewProvider.hasActiveView()) {
            return true;
        }
        vscode.window.showErrorMessage('Extension not ready. Try reopening the panel.');
        return false;
    };

    // Command to get next GIF
    const nextCommand = vscode.commands.registerCommand('funny-cooking-gifs.nextGif', async () => {
        if (gifViewProvider) {
            await gifViewProvider.updateGif();
        }
    });

    // Command to toggle music playback
    const musicCommand = vscode.commands.registerCommand('funny-cooking-gifs.toggleMusic', () => {
        if (!ensureViewReady()) {
            return;
        }
        gifViewProvider.postMessage({ command: 'toggleMusic' });
    });

    // Command to stop music
    const stopMusicCommand = vscode.commands.registerCommand('funny-cooking-gifs.stopMusic', () => {
        if (!ensureViewReady()) {
            return;
        }
        gifViewProvider.postMessage({ command: 'stopMusic' });
    });

    // Command to refresh GIF cache
    const refreshGifListCommand = vscode.commands.registerCommand('funny-cooking-gifs.refreshGifList', async () => {
        if (!ensureViewReady()) {
            return;
        }
        try {
            await gifViewProvider.refreshGifList();
        } catch (error) {
            console.error('Failed to refresh GIF list:', error);
            vscode.window.showErrorMessage('Failed to refresh GIF list. Check logs for details.');
        }
    });

    context.subscriptions.push(nextCommand, refreshGifListCommand, musicCommand, stopMusicCommand);
}

class GifViewProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._view = null;
        this._autoRefreshInterval = null;
        this._currentGifData = null;
        this._isFetchingGif = false;
        this._gifCache = [];
        this._gifCacheConfig = null;
        this._gifListLoadPromise = null;
        this._gifListLoadSignature = null;
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

        webviewView.onDidDispose(() => {
            this.clearAutoRefresh();
            this._view = null;
        });

        // Initial load - set HTML once
        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        const displayDuration = config.get('displayDuration', 5);
        const autoPlay = config.get('autoPlay', true);
        const panelTitle = config.get('commandTitle', '🔥🔥🔥');
        const s3Bucket = config.get('s3Bucket', 'let-them-cook-now');
        const s3Region = config.get('s3Region', 'us-east-1');
        const s3Prefix = config.get('s3Prefix', 'gifs/');

        this._view.webview.html = this.getWebviewContent(panelTitle, displayDuration, autoPlay);

        this.loadGifList({ bucket: s3Bucket, region: s3Region, prefix: s3Prefix }).catch(error => {
            console.error('Failed to preload GIF list:', error);
        });

        // Then load first GIF
        this.updateGif();
        this.setupAutoRefresh();
    }

    async updateGif() {
        if (!this._view || this._isFetchingGif) {
            return;
        }

        this._isFetchingGif = true;

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
        } finally {
            this._isFetchingGif = false;
        }
    }

    getGifConfig() {
        const config = vscode.workspace.getConfiguration('funnyCookingGifs');
        return {
            bucket: config.get('s3Bucket', 'let-them-cook-now'),
            region: config.get('s3Region', 'us-east-1'),
            prefix: config.get('s3Prefix', 'gifs/')
        };
    }

    async loadGifList({ bucket, region, prefix, force = false } = {}) {
        if (!bucket || !region || !prefix) {
            const defaults = this.getGifConfig();
            bucket = bucket || defaults.bucket;
            region = region || defaults.region;
            prefix = prefix || defaults.prefix;
        }

        const signature = `${bucket}|${region}|${prefix}`;

        if (signature !== this._gifCacheConfig) {
            this._gifCache = [];
        }

        if (this._gifListLoadPromise && this._gifListLoadSignature !== signature) {
            this._gifListLoadPromise = null;
            this._gifListLoadSignature = null;
        }

        if (!force && this._gifCache.length > 0) {
            return this._gifCache;
        }

        if (!force && this._gifListLoadPromise) {
            return this._gifListLoadPromise;
        }

        const loader = (async () => {
            const gifKeys = await this.collectS3Keys(bucket, region, prefix, ['.gif']);
            this._gifCache = gifKeys;
            this._gifCacheConfig = signature;
            console.log(`gif list loaded: ${gifKeys.length}`);
            return gifKeys;
        })();

        if (force) {
            return loader;
        }

        this._gifListLoadSignature = signature;
        this._gifListLoadPromise = loader;
        try {
            return await loader;
        } finally {
            if (this._gifListLoadPromise === loader) {
                this._gifListLoadPromise = null;
                this._gifListLoadSignature = null;
            }
        }
    }

    async refreshGifList() {
        const { bucket, region, prefix } = this.getGifConfig();
        await this.loadGifList({ bucket, region, prefix, force: true });
        if (this._view) {
            await this.updateGif();
        }
    }

    async fetchRandomFileFromS3(bucket, region, prefix, fileExtensions, formatResponse = null) {
        const fileKeys = await this.collectS3Keys(bucket, region, prefix, fileExtensions);

        if (!fileKeys || fileKeys.length === 0) {
            return null;
        }

        const randomKey = fileKeys[Math.floor(Math.random() * fileKeys.length)];
        const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(randomKey).replace(/%2F/g, '/')}`;

        if (formatResponse) {
            return formatResponse(randomKey, fileUrl);
        }

        return {
            url: fileUrl,
            key: randomKey,
            title: randomKey.split('/').pop()
        };
    }

    async fetchRandomGifFromS3(bucket, region, prefix) {
        const gifKeys = await this.loadGifList({ bucket, region, prefix });

        if (!gifKeys || gifKeys.length === 0) {
            return null;
        }

        const randomKey = gifKeys[Math.floor(Math.random() * gifKeys.length)];
        const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(randomKey).replace(/%2F/g, '/')}`;

        return {
            id: randomKey,
            title: randomKey.split('/').pop().replace('.gif', ''),
            images: {
                original: {
                    url: fileUrl
                }
            }
        };
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

    async collectS3Keys(bucket, region, prefix, fileExtensions) {
        const collectedKeys = [];
        let continuationToken = null;

        do {
            const { keys, isTruncated, nextContinuationToken } = await this.listS3Page(bucket, region, prefix, continuationToken);

            const filteredKeys = keys.filter(key => {
                const lowerKey = key.toLowerCase();
                return fileExtensions.some(ext => lowerKey.endsWith(ext.toLowerCase())) && key !== prefix;
            });

            collectedKeys.push(...filteredKeys);

            if (!isTruncated || !nextContinuationToken) {
                break;
            }

            continuationToken = nextContinuationToken;
        } while (continuationToken);

        return collectedKeys;
    }

    listS3Page(bucket, region, prefix, continuationToken = null) {
        return new Promise((resolve, reject) => {
            const queryParts = [
                'list-type=2',
                `prefix=${encodeURIComponent(prefix)}`
            ];

            if (continuationToken) {
                queryParts.push(`continuation-token=${encodeURIComponent(continuationToken)}`);
            }

            const url = `https://${bucket}.s3.${region}.amazonaws.com/?${queryParts.join('&')}`;

            https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        const snippet = data ? ` Response: ${data.substring(0, 200)}...` : '';
                        reject(new Error(`S3 request failed with status ${res.statusCode}.${snippet}`));
                        return;
                    }

                    try {
                        const keyMatches = data.match(/<Key>([^<]+)<\/Key>/g) || [];
                        const keys = keyMatches.map(match => match.replace(/<\/?Key>/g, ''));
                        const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(data);
                        const nextTokenMatch = data.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);

                        resolve({
                            keys,
                            isTruncated,
                            nextContinuationToken: nextTokenMatch ? nextTokenMatch[1] : null
                        });
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', (err) => {
                reject(err);
            });
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

    postMessage(message) {
        if (this._view) {
            this._view.webview.postMessage(message);
            return true;
        }
        return false;
    }

    hasActiveView() {
        return !!this._view;
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
