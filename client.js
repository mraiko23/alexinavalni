// Client-side script - only polls OUR API
const POLL_INTERVAL = 5000; // 5 seconds - fast UI updates

// State
let currentStock = { gear: [], seed: [] };
let trackedItems = new Set(JSON.parse(localStorage.getItem('trackedItems') || '[]'));
let notificationsEnabled = false;
let lastStockHash = '';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    console.log('🌱 Plants vs Brainrots Stock Tracker started');
    checkNotificationPermission();
    updateTrackedItemsUI();
    startPolling();
});

// Notification handling
function checkNotificationPermission() {
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            notificationsEnabled = true;
            document.getElementById('notificationsBtn').textContent = '✅ Уведомления включены';
            document.getElementById('notificationsBtn').disabled = true;
        }
    } else {
        document.getElementById('notificationsBtn').textContent = '❌ Не поддерживается';
        document.getElementById('notificationsBtn').disabled = true;
    }
}

async function requestNotificationPermission() {
    if ('Notification' in window) {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            notificationsEnabled = true;
            document.getElementById('notificationsBtn').textContent = '✅ Уведомления включены';
            document.getElementById('notificationsBtn').disabled = true;
            new Notification('🌱 Plants vs Brainrots', {
                body: 'Уведомления успешно включены! Вы получите уведомление, когда отслеживаемый предмет появится в стоке.',
                icon: '🌱'
            });
        } else {
            alert('Пожалуйста, разрешите уведомления в настройках браузера');
        }
    }
}

function sendNotification(itemName) {
    if (notificationsEnabled && Notification.permission === 'granted') {
        new Notification('🌱 Предмет в стоке!', {
            body: `${itemName} теперь доступен в стоке!`,
            icon: '⭐',
            tag: itemName
        });
    }
}

// Polling - only our local API
function startPolling() {
    console.log('Starting to poll /api/stock');
    pollStock();
    setInterval(pollStock, POLL_INTERVAL);
}

async function pollStock() {
    try {
        document.getElementById('statusText').textContent = '⚡ Обновление...';
        
        // Fetch stock data
        const stockResponse = await fetch('/api/stock');
        if (!stockResponse.ok) {
            throw new Error(`HTTP ${stockResponse.status}`);
        }
        const stockData = await stockResponse.json();
        updateStockData(stockData);
        
        // Fetch sources status
        const sourcesResponse = await fetch('/api/sources');
        if (sourcesResponse.ok) {
            const sourcesData = await sourcesResponse.json();
            updateSourcesUI(sourcesData);
            
            const healthyCount = sourcesData.filter(s => s.isValid).length;
            document.getElementById('healthySources').textContent = `Источников: ${healthyCount}/${sourcesData.length}`;
        }
        
        document.getElementById('statusText').textContent = '✅ Активен';
        document.getElementById('statusIndicator').classList.add('active');
        
    } catch (error) {
        console.error('Error polling stock:', error);
        document.getElementById('statusText').textContent = '❌ Ошибка';
        document.getElementById('statusIndicator').classList.remove('active');
    }
}

function updateStockData(stockData) {
    const newHash = hashStock(stockData);
    
    // Check if stock changed
    if (newHash !== lastStockHash) {
        checkForTrackedItems(stockData);
        currentStock = stockData;
        updateStockUI(stockData);
        lastStockHash = newHash;
    }
}

function hashStock(stockData) {
    const gearHash = stockData.gear.map(i => `${i.name}:${i.quantity}`).sort().join(',');
    const seedHash = stockData.seed.map(i => `${i.name}:${i.quantity}`).sort().join(',');
    return `${gearHash}|${seedHash}`;
}

function checkForTrackedItems(newStock) {
    const allItems = [...newStock.gear, ...newStock.seed];
    const itemNames = allItems.map(item => item.name.toLowerCase());

    trackedItems.forEach(trackedItem => {
        if (itemNames.includes(trackedItem.toLowerCase())) {
            sendNotification(trackedItem);
        }
    });
}

function updateStockUI(stock) {
    // Update gear stock
    const gearContainer = document.getElementById('gearStockItems');
    if (stock.gear && stock.gear.length > 0) {
        gearContainer.innerHTML = stock.gear.map(item => createStockItemHTML(item, 'gear')).join('');
    } else {
        gearContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
    }

    // Update seed stock
    const seedContainer = document.getElementById('seedStockItems');
    if (stock.seed && stock.seed.length > 0) {
        seedContainer.innerHTML = stock.seed.map(item => createStockItemHTML(item, 'seed')).join('');
    } else {
        seedContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
    }

    // Update timestamps
    const time = new Date(stock.reportedAt || Date.now()).toLocaleTimeString('ru-RU');
    document.getElementById('gearUpdate').textContent = time;
    document.getElementById('seedUpdate').textContent = time;
    document.getElementById('lastUpdateTime').textContent = `Последнее обновление: ${time}`;
}

function createStockItemHTML(item, type) {
    const isTracked = trackedItems.has(item.name);
    const quantity = parseInt(item.quantity) || 1;
    
    return `
        <div class="stock-item ${isTracked ? 'tracked' : ''}" onclick="toggleTracking('${escapeHtml(item.name)}')">
            <div class="item-name">${escapeHtml(item.name)}</div>
            <div class="item-quantity">×${quantity}</div>
        </div>
    `;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function addManualTracking() {
    const input = document.getElementById('manualTrackInput');
    const itemName = input.value.trim();
    
    if (itemName) {
        trackedItems.add(itemName);
        localStorage.setItem('trackedItems', JSON.stringify([...trackedItems]));
        input.value = '';
        updateTrackedItemsUI();
        updateStockUI(currentStock);
    } else {
        alert('Введите название предмета');
    }
}

function toggleTracking(itemName) {
    if (trackedItems.has(itemName)) {
        trackedItems.delete(itemName);
    } else {
        trackedItems.add(itemName);
    }
    
    localStorage.setItem('trackedItems', JSON.stringify([...trackedItems]));
    updateTrackedItemsUI();
    updateStockUI(currentStock);
}

function updateTrackedItemsUI() {
    const container = document.getElementById('trackedItems');
    
    if (trackedItems.size === 0) {
        container.innerHTML = '<div class="empty-state">👆 Нажмите на предмет в стоке или введите название выше</div>';
        return;
    }

    container.innerHTML = [...trackedItems].map(item => `
        <div class="tracked-item">
            <span>${escapeHtml(item)}</span>
            <button onclick="toggleTracking('${escapeHtml(item)}')">×</button>
        </div>
    `).join('');
}

function updateSourcesUI(sources) {
    const container = document.getElementById('sourcesList');
    if (!container) return;
    
    container.innerHTML = sources.map(source => {
        let status = 'broken';
        let statusText = '❌ Недоступен';
        let info = '';
        
        if (source.isValid) {
            status = 'healthy';
            statusText = '✅ Работает';
            info = `⚙️ Gear: ${source.gearCount} | 🌱 Seeds: ${source.seedCount}`;
        } else if (source.error) {
            info = `❌ ${source.message || 'Ошибка сети'}`;
        } else {
            info = '⌛ Ожидание ответа...';
        }

        return `
            <div class="source-item ${status}">
                <div class="source-header">
                    <span class="source-name">${source.name}</span>
                    <span class="source-status ${status}">${statusText}</span>
                </div>
                <div class="source-info">${info}</div>
            </div>
        `;
    }).join('');
}
