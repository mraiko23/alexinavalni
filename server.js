const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Configuration
// Note: CORS proxy is NOT needed for server-side requests!
// useCorsProxy is kept false for all sources since we're making requests from Node.js, not browser
const SOURCES = [
    { id: 1, url: 'https://api.plantvsbrainrots.org/api/stock/latest', type: 'api', name: 'API Source 1', useCorsProxy: false },
    { id: 2, url: 'https://plants-vs-brainrots.com/api/stock/', type: 'api', name: 'API Source 2', useCorsProxy: false },
    { id: 3, url: 'https://plantsvsbrainrotsstocktracker.com/api/stock?since=0', type: 'api', name: 'API Source 3', useCorsProxy: false },
    { id: 5, url: 'https://plantsvsbrainrotswikia.com/api/stock/current', type: 'api', name: 'API Source 5', useCorsProxy: false }
];

const CORS_PROXY = 'https://corsproxy.io/?';
const POLL_INTERVAL = 10000; // 10 seconds
const REQUEST_TIMEOUT = 15000; // 15 seconds

// Proxy configuration (optional)
// Set HTTP_PROXY or HTTPS_PROXY environment variable to use proxy
// Example: HTTP_PROXY=http://proxy.example.com:8080
const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

if (proxyAgent) {
    console.log(`🌐 Using proxy: ${proxyUrl}`);
}

// Global stock data storage
let currentStockData = {
    gear: [],
    seed: [],
    reportedAt: Date.now()
};

let sourcesData = new Map();
let lastUpdateTime = Date.now();

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Fetch data from external API
async function fetchFromURL(url) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, REQUEST_TIMEOUT);

        const options = {
            agent: proxyAgent // Use proxy agent if configured
        };

        https.get(url, options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                clearTimeout(timeout);
                try {
                    const jsonData = JSON.parse(data);
                    resolve(jsonData);
                } catch (e) {
                    reject(new Error('Invalid JSON'));
                }
            });
        }).on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// Parse API response
function parseAPIResponse(data, source) {
    let gearStock = [];
    let seedStock = [];
    let reportedAt = Date.now();

    try {
        // Format 1: {items: [...], updatedAt/reportedAt: timestamp}
        if (data.items && Array.isArray(data.items)) {
            data.items.forEach(item => {
                const normalizedItem = {
                    name: item.name || item.id || 'Unknown',
                    quantity: item.currentStock || item.qty || item.stock || item.quantity || item.amount || item.count || 1
                };

                // Classify by category
                if (item.category === 'seed' || item.category === 'seeds' || item.category === 'plant' || item.category === 'plants' || 
                    item.id?.includes('seed') || item.id?.includes('plant') || 
                    item.name?.toLowerCase().includes('seed') || item.name?.toLowerCase().includes('plant')) {
                    seedStock.push(normalizedItem);
                } else if (item.category === 'gear' || item.category === 'gears' || 
                           item.id?.includes('gear') || item.name?.toLowerCase().includes('gear')) {
                    gearStock.push(normalizedItem);
                } else {
                    if (item.name?.toLowerCase().includes('seed') || item.name?.toLowerCase().includes('plant')) {
                        seedStock.push(normalizedItem);
                    } else {
                        gearStock.push(normalizedItem);
                    }
                }
            });
            
            reportedAt = data.updatedAt || data.reportedAt || data.timestamp || Date.now();
        }
        // Format 2: {stock: {gear: [...], seed: [...]}}
        else if (data.stock) {
            gearStock = normalizeItems(data.stock.gear || data.stock.gearStock || data.stock.gears || []);
            seedStock = normalizeItems(data.stock.seed || data.stock.seedStock || data.stock.seeds || []);
            reportedAt = data.stock.reportedAt || data.stock.timestamp || data.reportedAt || Date.now();
        }
        // Format 3: Direct {gears: [...], seeds: [...]} or {gear: [...], seed: [...]}
        else if (data.gears || data.gear || data.seeds || data.seed) {
            gearStock = normalizeItems(data.gears || data.gear || []);
            seedStock = normalizeItems(data.seeds || data.seed || []);
            
            const timeValue = data.reportedAt || data.effectiveTime || data.updatedAt || data.timestamp || Date.now();
            reportedAt = typeof timeValue === 'string' ? new Date(timeValue).getTime() : timeValue;
        }
        // Format 4: Array of items
        else if (Array.isArray(data)) {
            data.forEach(item => {
                const normalizedItem = normalizeItem(item);
                if (item.type === 'gear' || item.category === 'gear') {
                    gearStock.push(normalizedItem);
                } else {
                    seedStock.push(normalizedItem);
                }
            });
            reportedAt = Date.now();
        }

        return {
            gear: gearStock,
            seed: seedStock,
            reportedAt: reportedAt,
            isValid: gearStock.length > 0 || seedStock.length > 0,
            source: source.id
        };
    } catch (err) {
        console.error(`Error parsing API ${source.name}:`, err.message);
        return {
            gear: [],
            seed: [],
            reportedAt: Date.now(),
            isValid: false,
            source: source.id,
            error: true,
            message: err.message
        };
    }
}

function normalizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map(item => normalizeItem(item));
}

function normalizeItem(item) {
    return {
        name: item.name || item.id || 'Unknown',
        quantity: item.quantity || item.currentStock || item.qty || item.stock || item.amount || item.count || 1
    };
}

// Fetch data from a single source
async function fetchSourceData(source) {
    try {
        const fetchUrl = source.useCorsProxy ? CORS_PROXY + encodeURIComponent(source.url) : source.url;
        console.log(`[${new Date().toISOString()}] Fetching ${source.name}...`);
        
        const data = await fetchFromURL(fetchUrl);
        const parsed = parseAPIResponse(data, source);
        
        console.log(`[${new Date().toISOString()}] ✅ ${source.name}: ${parsed.gear.length} gear, ${parsed.seed.length} seed`);
        return parsed;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ ${source.name}: ${error.message}`);
        return {
            gear: [],
            seed: [],
            error: true,
            message: error.message,
            source: source.id,
            reportedAt: Date.now(),
            isValid: false
        };
    }
}

// Calculate consensus from all sources
function calculateConsensus() {
    const allSources = Array.from(sourcesData.values());
    const validSources = allSources.filter(data => data.isValid);
    
    if (validSources.length === 0) {
        return null;
    }

    if (validSources.length === 1) {
        return validSources[0];
    }
    
    // Check for fresh sources with timestamps divisible by 5 minutes
    function isFreshRoundedTime(timestamp) {
        const date = new Date(timestamp);
        const minutes = date.getMinutes();
        const seconds = date.getSeconds();
        return minutes % 5 === 0 && seconds <= 30;
    }
    
    const freshSources = validSources.filter(source => isFreshRoundedTime(source.reportedAt));
    
    if (freshSources.length > 0) {
        const newestFresh = freshSources.sort((a, b) => b.reportedAt - a.reportedAt)[0];
        const otherSources = validSources.filter(s => s.source !== newestFresh.source);
        
        if (otherSources.length > 0) {
            const freshGearCount = newestFresh.gear.length;
            const freshSeedCount = newestFresh.seed.length;
            const freshTotalCount = freshGearCount + freshSeedCount;
            
            const bestOther = otherSources.reduce((best, current) => {
                const bestCount = best.gear.length + best.seed.length;
                const currentCount = current.gear.length + current.seed.length;
                return currentCount > bestCount ? current : best;
            }, otherSources[0]);
            
            const otherGearCount = bestOther.gear.length;
            const otherSeedCount = bestOther.seed.length;
            const otherTotalCount = otherGearCount + otherSeedCount;
            
            if (freshTotalCount > otherTotalCount || 
                (freshTotalCount === otherTotalCount && freshGearCount >= otherGearCount)) {
                console.log(`[${new Date().toISOString()}] ⭐ Using fresh data (${freshGearCount} gear + ${freshSeedCount} seed)`);
                return newestFresh;
            }
        }
    }
    
    // Smart aggregation
    const sourcesWithGear = validSources.filter(s => s.gear.length > 0);
    const sourcesWithSeed = validSources.filter(s => s.seed.length > 0);
    
    let consensusGear = [];
    let gearReportedAt = Date.now();
    
    if (sourcesWithGear.length > 0) {
        const gearGroups = new Map();
        sourcesWithGear.forEach(source => {
            const hash = source.gear.map(i => `${i.name}:${i.quantity}`).sort().join(',');
            if (!gearGroups.has(hash)) {
                gearGroups.set(hash, []);
            }
            gearGroups.get(hash).push(source);
        });
        
        let largestGearGroup = [];
        gearGroups.forEach(group => {
            if (group.length > largestGearGroup.length) {
                largestGearGroup = group;
            }
        });
        
        const bestGearSource = largestGearGroup.sort((a, b) => b.reportedAt - a.reportedAt)[0];
        consensusGear = bestGearSource.gear;
        gearReportedAt = bestGearSource.reportedAt;
    }
    
    let consensusSeed = [];
    let seedReportedAt = Date.now();
    
    if (sourcesWithSeed.length > 0) {
        const seedGroups = new Map();
        sourcesWithSeed.forEach(source => {
            const hash = source.seed.map(i => `${i.name}:${i.quantity}`).sort().join(',');
            if (!seedGroups.has(hash)) {
                seedGroups.set(hash, []);
            }
            seedGroups.get(hash).push(source);
        });
        
        let largestSeedGroup = [];
        seedGroups.forEach(group => {
            if (group.length > largestSeedGroup.length) {
                largestSeedGroup = group;
            }
        });
        
        const bestSeedSource = largestSeedGroup.sort((a, b) => b.reportedAt - a.reportedAt)[0];
        consensusSeed = bestSeedSource.seed;
        seedReportedAt = bestSeedSource.reportedAt;
    }

    return {
        gear: consensusGear,
        seed: consensusSeed,
        reportedAt: Math.max(gearReportedAt, seedReportedAt),
        isValid: consensusGear.length > 0 || consensusSeed.length > 0,
        source: 'aggregated'
    };
}

// Poll all sources
async function pollAllSources() {
    console.log(`\n[${new Date().toISOString()}] 🚀 Polling all sources...`);
    
    const promises = SOURCES.map(async (source) => {
        try {
            const data = await fetchSourceData(source);
            sourcesData.set(source.id, data);
        } catch (error) {
            sourcesData.set(source.id, { 
                gear: [],
                seed: [],
                error: true, 
                message: error.toString(), 
                source: source.id,
                reportedAt: Date.now(),
                isValid: false
            });
        }
    });

    await Promise.allSettled(promises);
    
    // Calculate consensus
    const consensusStock = calculateConsensus();
    if (consensusStock) {
        currentStockData = {
            gear: consensusStock.gear.map(item => ({
                name: item.name,
                quantity: item.quantity
            })),
            seed: consensusStock.seed.map(item => ({
                name: item.name,
                quantity: item.quantity
            })),
            reportedAt: consensusStock.reportedAt
        };
        lastUpdateTime = Date.now();
        console.log(`[${new Date().toISOString()}] ✅ Stock updated: ${currentStockData.gear.length} gear, ${currentStockData.seed.length} seed`);
    }
}

// Start polling
console.log('Starting background polling...');
pollAllSources(); // Initial poll
setInterval(pollAllSources, POLL_INTERVAL);

// HTTP Server
const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // API endpoint for stock data
    if (req.url === '/api/stock' || req.url === '/api/stock/latest') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(currentStockData));
            return;
        }
    }

    // API endpoint for sources status
    if (req.url === '/api/sources') {
        if (req.method === 'GET') {
            const sourcesStatus = SOURCES.map(source => {
                const data = sourcesData.get(source.id);
                return {
                    id: source.id,
                    name: source.name,
                    isValid: data ? data.isValid : false,
                    gearCount: data ? data.gear.length : 0,
                    seedCount: data ? data.seed.length : 0,
                    error: data ? data.error : false,
                    message: data ? data.message : 'Waiting...'
                };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(sourcesStatus));
            return;
        }
    }

    // Serve static files
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}`, 'utf-8');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`API endpoint available at http://localhost:${PORT}/api/stock`);
    console.log(`Polling every ${POLL_INTERVAL/1000} seconds`);
});
