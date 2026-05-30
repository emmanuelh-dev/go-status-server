const history = {
    cpu: [],
    ram: [],
    netDown: [],
    netUp: [],
    maxPoints: 40
};

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const sizeName = sizes[i] || 'B/s';
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizeName.replace('/s', '');
}

function formatBytesTotal(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

function drawSparkline(canvasId, data, color, isPercentage = true, maxVal = 100, clear = true) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    const rect = canvas.parentNode.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    
    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    
    if (clear) {
        ctx.clearRect(0, 0, rect.width, rect.height);
    }
    
    if (data.length < 2) return;
    
    let currentMax = maxVal;
    if (!isPercentage) {
        currentMax = Math.max(...data, 1024); // at least 1KB/s
    }
    
    const width = rect.width;
    const height = rect.height;
    
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    const step = width / (history.maxPoints - 1);
    
    data.forEach((val, index) => {
        const x = width - (data.length - 1 - index) * step;
        const normVal = currentMax > 0 ? Math.min(val / currentMax, 1) : 0;
        const y = height - (normVal * (height - 8)) - 4; // padding
        
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    ctx.stroke();
    
    // Create gradient fill below the line
    ctx.lineTo(width, height);
    const startX = width - (data.length - 1) * step;
    ctx.lineTo(startX, height);
    ctx.closePath();
    
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, color.replace('rgb', 'rgba').replace(')', ', 0.15)'));
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fill();
}

async function updateDashboard() {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('API Response Error');
        const dataList = await response.json();

        if (!Array.isArray(dataList) || dataList.length === 0) return;

        // Current/latest data point is the last element
        const data = dataList[dataList.length - 1];

        // 1. Host Meta & Uptime
        document.getElementById('system-meta').textContent = 
            `${data.host.hostname} • ${data.host.os} (${data.host.platform}) • Kernel: ${data.host.kernelVersion}`;
        document.getElementById('uptime-val').textContent = `Uptime: ${formatUptime(data.host.uptime)}`;

        // 2. CPU
        const cpuUsage = Math.round(data.cpu.usage);
        document.getElementById('cpu-cores').textContent = `${data.cpu.cores} Cores`;
        document.getElementById('cpu-usage-val').textContent = `${cpuUsage}%`;
        document.getElementById('cpu-model').textContent = data.cpu.modelName;

        // Radial Progress
        const offset = 251.2 - (cpuUsage / 100) * 251.2;
        const radialFg = document.getElementById('cpu-radial-fg');
        radialFg.style.strokeDashoffset = offset;

        if (cpuUsage > 85) {
            radialFg.style.stroke = 'var(--danger)';
        } else if (cpuUsage > 60) {
            radialFg.style.stroke = 'var(--warning)';
        } else {
            radialFg.style.stroke = 'var(--primary)';
        }

        // Rebuild CPU history
        history.cpu = dataList.map(d => Math.round(d.cpu.usage));
        drawSparkline('cpu-trend', history.cpu, 'rgb(59, 130, 246)', true, 100);

        // Render Cores
        const coreGrid = document.getElementById('core-grid');
        coreGrid.innerHTML = '';
        if (data.cpu.usagePerCore) {
            data.cpu.usagePerCore.forEach((usage, idx) => {
                const coreVal = Math.round(usage);
                const coreItem = document.createElement('div');
                coreItem.className = 'core-item';
                
                let barColor = 'var(--primary)';
                if (coreVal > 85) barColor = 'var(--danger)';
                else if (coreVal > 60) barColor = 'var(--warning)';

                coreItem.innerHTML = `
                     <div class="core-bar-wrapper">
                         <div class="core-bar-fill" style="height: ${coreVal}%; background: ${barColor};"></div>
                     </div>
                     <span class="core-label">C${idx}</span>
                 `;
                coreGrid.appendChild(coreItem);
            });
        }

        // 3. RAM
        const ramPercent = Math.round(data.memory.percent);
        document.getElementById('ram-percent').textContent = `${ramPercent}%`;
        const ramBar = document.getElementById('ram-bar');
        ramBar.style.width = `${ramPercent}%`;
        if (ramPercent > 85) ramBar.style.background = 'var(--danger)';
        else if (ramPercent > 60) ramBar.style.background = 'var(--warning)';
        else ramBar.style.background = 'linear-gradient(90deg, var(--primary) 0%, #818cf8 100%)';

        document.getElementById('ram-used').textContent = formatBytesTotal(data.memory.used);
        document.getElementById('ram-available').textContent = formatBytesTotal(data.memory.available);
        document.getElementById('ram-total').textContent = formatBytesTotal(data.memory.total);

        // Rebuild RAM history
        history.ram = dataList.map(d => Math.round(d.memory.percent));
        drawSparkline('ram-trend', history.ram, 'rgb(129, 140, 248)', true, 100);

        // 4. Disk
        const diskPercent = Math.round(data.disk.percent);
        document.getElementById('disk-percent').textContent = `${diskPercent}%`;
        const diskBar = document.getElementById('disk-bar');
        diskBar.style.width = `${diskPercent}%`;
        if (diskPercent > 90) diskBar.style.background = 'var(--danger)';
        else if (diskPercent > 75) diskBar.style.background = 'var(--warning)';
        else diskBar.style.background = 'linear-gradient(90deg, var(--primary) 0%, #818cf8 100%)';

        document.getElementById('disk-used').textContent = formatBytesTotal(data.disk.used);
        document.getElementById('disk-free').textContent = formatBytesTotal(data.disk.free);
        document.getElementById('disk-total').textContent = formatBytesTotal(data.disk.total);

        // 5. Network (rebuild history rate)
        history.netDown = [];
        history.netUp = [];
        for (let i = 0; i < dataList.length; i++) {
            let rx = 0;
            let tx = 0;
            if (i > 0) {
                const prev = dataList[i - 1];
                const curr = dataList[i];
                const timeDiff = curr.timestamp - prev.timestamp;
                if (timeDiff > 0) {
                    rx = Math.max(0, (curr.network.bytesRecv - prev.network.bytesRecv) / timeDiff);
                    tx = Math.max(0, (curr.network.bytesSent - prev.network.bytesSent) / timeDiff);
                }
            }
            history.netDown.push(rx);
            history.netUp.push(tx);
        }

        const latestRx = history.netDown[history.netDown.length - 1] || 0;
        const latestTx = history.netUp[history.netUp.length - 1] || 0;

        document.getElementById('net-total').textContent = `Subida: ${formatBytesTotal(data.network.bytesSent)} | Bajada: ${formatBytesTotal(data.network.bytesRecv)}`;
        document.getElementById('net-down-rate').textContent = `${formatBytes(latestRx)}`;
        document.getElementById('net-up-rate').textContent = `${formatBytes(latestTx)}`;

        const maxNet = Math.max(...history.netDown, ...history.netUp, 1024);
        drawSparkline('net-trend', history.netDown, 'rgb(16, 185, 129)', false, maxNet, true);
        drawSparkline('net-trend', history.netUp, 'rgb(245, 158, 11)', false, maxNet, false);

        // 6. Battery
        const batInfo = data.battery;
        const batCard = document.getElementById('battery-card');
        if (batInfo.hasBattery) {
            batCard.style.display = 'flex';
            const batPercent = Math.round(batInfo.percent);
            document.getElementById('battery-status').textContent = batInfo.status;
            document.getElementById('battery-percent').textContent = `${batPercent}%`;
            
            const batLevel = document.getElementById('battery-level');
            batLevel.style.width = `${batPercent}%`;
            
            if (batInfo.status === 'Charging') {
                batLevel.style.background = 'linear-gradient(90deg, var(--success) 0%, #34d399 100%)';
                document.getElementById('battery-status-text').textContent = `Cargando (${batPercent}%)`;
            } else {
                if (batPercent <= 15) {
                    batLevel.style.background = 'var(--danger)';
                    document.getElementById('battery-status-text').textContent = `Batería baja (${batPercent}%)`;
                } else if (batPercent <= 35) {
                    batLevel.style.background = 'var(--warning)';
                    document.getElementById('battery-status-text').textContent = `Descargando (${batPercent}%)`;
                } else {
                    batLevel.style.background = 'linear-gradient(90deg, var(--success) 0%, #34d399 100%)';
                    document.getElementById('battery-status-text').textContent = `Descargando (${batPercent}%)`;
                }
            }
        } else {
            document.getElementById('battery-status').textContent = 'N/A';
            document.getElementById('battery-percent').textContent = '0%';
            document.getElementById('battery-level').style.width = '0%';
            document.getElementById('battery-status-text').textContent = 'No se detectó batería (PC de escritorio/servidor)';
        }

    } catch (err) {
        console.error('Error fetching system status:', err);
        document.getElementById('system-meta').textContent = 'Error de conexión con el servidor.';
    }
}

// Initial fetch and set interval
updateDashboard();
setInterval(updateDashboard, 2000);
